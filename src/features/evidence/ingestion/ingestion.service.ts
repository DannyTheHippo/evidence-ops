import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, mongo, Model, Types } from 'mongoose';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../../../providers/embedding/embedding-provider.interface';
import {
  COLLECTION as EVIDENCE_CHUNKS_COLLECTION,
  SEARCH_INDEX,
  VECTOR_INDEX,
} from '../../../providers/retrieval/retrieval.constant';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import { workflowRunFailedCounter } from '../../../providers/telemetry/domain-metrics';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  createSearchChunkCountProbe,
  createVectorChunkProbe,
  waitForIndexConvergence,
} from '../retrieval/search-index-readiness.util';
import { chunkElements } from './chunker';
import { computeChunkId } from './compute-chunk-id';
import { DocumentVersionNotFoundException } from './exceptions/ingestion.exception';
import { ParserRegistry } from './parser.registry';
import { screenInstructionInjection } from './screen-instruction-injection';

// Each `waitForIndexConvergence` call below spends up to this budget *twice* — once polling
// index status readiness, once polling the probe for convergence (see that function's own doc
// comment) — so one call's worst case is ~40s, not 20s. The search and vector waits run
// concurrently (`Promise.allSettled` below), so that ~40s is also the method's overall worst
// case, leaving ~80s of the `ingestDocumentVersion` activity's `startToCloseTimeout: '2 minutes'`
// (`src/workflows/ingest-document-version.workflow.ts`) for parse + embed, which run before this.
// `onTimeout: 'degrade'` below means a miss here never fails the activity; it only decides how
// long a slow-to-converge upload logs a stale-index warning before giving up and letting the
// (already-successful) ingest return.
const CONVERGENCE_TIMEOUT_MS = 20_000;
const CONVERGENCE_POLL_INTERVAL_MS = 1_000;

/** Shared by every place this service reports a caught error as text — `awaitSearchIndexConvergence`'s
 *  swallowed failures (a settled rejection on either wait, or a synchronous throw from a probe
 *  builder) and `recordIngestionFailure`'s `ingestionFailureReason` — one formatting rule, not
 *  several copies of the same ternary to keep in sync. */
function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface IngestionResult {
  readonly chunksCreated: number;
  /** True when this call was a no-op because the version was already ingested. */
  readonly alreadyIngested: boolean;
}

@Injectable()
export class IngestionService {
  private readonly db: mongo.Db;

  constructor(
    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,

    private readonly parserRegistry: ParserRegistry,

    @InjectConnection()
    connection: Connection,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(IngestionService.name);
    // Same invariant as `MongoHybridRetrievalStore`'s constructor: by the time any consumer of
    // `@InjectConnection()` is constructed, `connection.db` is always set in practice, but a
    // service that can't reach its database for the post-ingest convergence probe must refuse to
    // construct rather than fail confusingly mid-ingest.
    if (!connection.db) {
      throw new Error('Mongo connection has no active database handle');
    }
    this.db = connection.db;
  }

  /**
   * Loads a version's bytes, parses, chunks, embeds, and persists `EvidenceChunk` documents.
   *
   * Idempotent by `ingestionStatus` (not a chunk-count inference): a version's bytes never change
   * once created (a re-upload of different bytes is a new version — see
   * `DocumentsService.addVersion`), so `ingestionStatus === 'completed'` is a reliable signal to
   * skip re-embedding on every retry.
   *
   * Temporal activities are at-least-once (`ingest-document-version.workflow.ts`'s
   * `maximumAttempts: 3`), so two attempts for the same version can legitimately run concurrently
   * — a slow embed can outlive the activity's `startToCloseTimeout` and trigger a retry while the
   * original keeps running. The plain read above is stale the instant that happens, so recovery
   * and completion are gated behind a compare-and-set lease (`ingestionLeaseToken`) rather than
   * the read: `claimAttempt` atomically overwrites the token, so whichever attempt claims most
   * recently is the only one whose eventual `finalizeCompletion` can succeed. A lost claim (this
   * version is already `completed`) skips straight to a no-op — fails CLOSED toward "someone else
   * owns this", never toward re-deleting. A lost finalize (a newer attempt claimed the lease while
   * this one was mid-embed) rolls back only the chunks *this* attempt inserted — by
   * `ingestionAttemptToken`, not by `_id` — never the whole version's chunks, and never a
   * concurrent winning attempt's rows.
   *
   * Each chunk's `_id` is computed deterministically (`computeChunkId`), not pre-assigned at
   * random, so replaying the same version's bytes reproduces the same ids (see that function's
   * doc comment — this is what makes the eval replay cache, ADR-0007, able to hit at all). That
   * also means two concurrent attempts over the *same* version's bytes compute the *same* ids, so
   * a losing attempt's `insertMany` can fail on a duplicate key rather than a generic write error
   * — `rollbackChunks` scopes its delete to `{ documentVersionId, ingestionAttemptToken }`
   * specifically so that case (and a failed `insertMany` generally) never deletes rows a
   * concurrent, winning attempt already committed under a different token.
   */
  async ingestVersion(documentVersionId: string, tenantId: string): Promise<IngestionResult> {
    if (!Types.ObjectId.isValid(documentVersionId)) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    const version = await this.documentVersionModel.findOne({
      _id: documentVersionId,
      tenantId,
    });
    if (!version) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    if (version.ingestionStatus === 'completed') {
      this.logger.debug(`Document version '${documentVersionId}' already ingested; skipping`);
      return { chunksCreated: 0, alreadyIngested: true };
    }

    const leaseToken = new Types.ObjectId();
    const claimed = await this.claimAttempt(version._id, leaseToken);
    if (!claimed) {
      this.logger.debug(
        `Document version '${documentVersionId}' completed by a concurrent attempt; skipping`,
      );
      return { chunksCreated: 0, alreadyIngested: true };
    }

    // Every throw below this point runs inside the try — the invariant this block enforces is
    // that no error surviving the claim can leave the version at `ingestionStatus: 'pending'`
    // with a stale lease token: a byte-identical re-upload would dedupe onto that same version by
    // sha256 (`DocumentsService.addVersion`) and never trigger a fresh ingestion attempt, leaving
    // the document permanently stuck with no diagnosis anywhere.
    try {
      // Clean slate for this attempt now that it holds the current lease — anything left behind
      // by an earlier attempt (crashed, or since-superseded) is safe to clear, because that
      // attempt's own `finalizeCompletion` can no longer succeed once this claim has overwritten
      // its token. `deleteMany` against zero matching documents is a cheap, indexed no-op on the
      // ordinary first-ingest path.
      await this.evidenceChunkModel.deleteMany({ documentVersionId: version._id, tenantId });

      const stored = await this.documentStore.get(version.storageKey);
      if (!stored) {
        // Data-integrity fault, not a normal input-validation branch: `storageKey` is only ever
        // set from a successful `documentStore.put()` (see `DocumentsService`), so a miss here
        // means the store lost bytes it already confirmed writing — mirrors `DocumentsService
        // .assertCurrentVersion`'s use of a bare `InternalServerErrorException` for the same class
        // of impossible state.
        throw new InternalServerErrorException(
          `Document version '${documentVersionId}' has no resolvable content in the document store`,
        );
      }

      const parser = this.parserRegistry.resolve(stored.contentType);
      const parsed = await parser.parse(stored.content);

      // Screened before chunking, not after: `chunkElements` merges a run of elements sharing a
      // heading path (prose) or a window of rows (spreadsheet) into one `Chunk`, so screening a
      // whole chunk would quarantine every legitimate element merged alongside the one flagged
      // element — for this corpus, an entire comps table sharing one row-window, or (PDF elements
      // carry no heading path at all, so `chunkProse` treats a whole document as a single run)
      // every page of a PDF. An element is the finest unit a parser produces (`ParsedElement`'s
      // own doc comment), so filtering here is the smallest quarantine the pipeline can express.
      // It is still not free: a PDF page is also the finest unit `PdfPageLocator` can address
      // (`pdf.parser.ts`), so a flagged page's legitimate text on the same page is quarantined
      // along with it.
      const safeElements = parsed.elements.filter(
        (element) => !screenInstructionInjection(element.text),
      );
      const quarantinedCount = parsed.elements.length - safeElements.length;
      if (quarantinedCount > 0) {
        this.logger.debug(
          `Document version '${documentVersionId}' quarantined ${quarantinedCount} element(s) flagged by the instruction-injection screen; excluded before chunking and embedding`,
        );
      }

      const chunks = chunkElements(safeElements);

      if (chunks.length === 0) {
        // A version with zero extractable chunks is still a finished ingest, not a pending one —
        // without marking it `completed` here too, `ingestVersion` would re-parse it from scratch
        // on every future call forever.
        const finalized = await this.finalizeCompletion(version._id, leaseToken);
        if (!finalized) {
          this.logger.debug(
            `Document version '${documentVersionId}' ingest superseded by a newer attempt before finalizing zero chunks`,
          );
          return { chunksCreated: 0, alreadyIngested: true };
        }
        this.logger.debug(`Document version '${documentVersionId}' produced no chunks`);
        return { chunksCreated: 0, alreadyIngested: false };
      }

      const embeddingResult = await this.embeddingProvider.embed({
        inputs: chunks.map((chunk) => chunk.text),
        inputType: 'document',
      });

      const chunkDocs = chunks.map((chunk, index) => ({
        _id: computeChunkId({
          tenantId: version.tenantId,
          documentVersionSha256: version.sha256,
          ordinal: index,
          locator: chunk.locator,
        }),
        documentId: version.documentId,
        documentVersionId: version._id,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        embedding: embeddingResult.embeddings[index],
        locator: chunk.locator,
        tenantId: version.tenantId,
        ingestionAttemptToken: leaseToken,
      }));

      try {
        await this.evidenceChunkModel.insertMany(chunkDocs);
      } catch (error) {
        await this.rollbackChunks(version._id, leaseToken, tenantId);
        throw error;
      }

      const finalized = await this.finalizeCompletion(version._id, leaseToken);
      if (!finalized) {
        // A newer attempt claimed the lease while this one was embedding/inserting — these rows
        // are stale. Temporal already discards a superseded attempt's return value in favor of the
        // retry that actually finalizes, so the exact result shape here is inert; `alreadyIngested:
        // true` just avoids implying this attempt itself finished the job.
        await this.rollbackChunks(version._id, leaseToken, tenantId);
        this.logger.debug(
          `Document version '${documentVersionId}' ingest superseded by a newer attempt; rolled back up to ${chunkDocs.length} chunk(s)`,
        );
        return { chunksCreated: 0, alreadyIngested: true };
      }

      this.logger.debug(
        `Document version '${documentVersionId}' ingested into ${chunkDocs.length} chunks`,
      );

      // FAILURE DIRECTION: degrades, never blocks. Unlike the eval harness
      // (`eval/ingest-fixtures.ts`, `onTimeout: 'throw'`), a user who just uploaded a document
      // must not have this request hang, or an otherwise-successful ingest turn into a failure,
      // because Atlas hasn't finished absorbing the last few chunks yet — see
      // `awaitSearchIndexConvergence`'s own doc comment.
      await this.awaitSearchIndexConvergence(
        documentVersionId,
        version.tenantId,
        chunkDocs.length,
        chunkDocs[0],
      );

      return { chunksCreated: chunkDocs.length, alreadyIngested: false };
    } catch (error) {
      await this.recordIngestionFailure(version._id, leaseToken, documentVersionId, error);
      throw error;
    }
  }

  /**
   * Best-effort post-ingest nudge, not a correctness gate — by the time this runs, the chunks are
   * already durably committed (`finalizeCompletion` above already succeeded). `knownChunk` is
   * `ingestVersion`'s own `chunkDocs[0]`: that array is a 1:1 `.map()` over `chunks`, and the
   * caller only reaches this method after the `chunks.length === 0` branch above has already
   * returned, so the type states what was previously an unreachable runtime guard — a caller
   * cannot pass an empty set here.
   *
   * Swallows every failure, not only a convergence timeout. The two waits run under
   * `Promise.allSettled`, not `Promise.all`, specifically so a rejection on one side never
   * abandons the other mid-poll — both results are inspected regardless of outcome, so there is
   * no correctness reason to let one side's failure short-circuit the other's still-useful wait.
   * `waitForIndexConvergence`'s own `onTimeout: 'degrade'` covers "index reports queryable but
   * hasn't absorbed these chunks yet" by resolving rather than rejecting, so a settled rejection
   * here means something else went wrong (a dropped index, a transient connectivity blip). The
   * surrounding try/catch covers the one thing `allSettled` cannot: `createSearchChunkCountProbe`/
   * `createVectorChunkProbe` build their probes synchronously, before either wait starts, so a
   * throw from either builder never reaches `allSettled` at all. Either path — a settled rejection
   * or a builder throw — degrades the same way: a user who already got a successful upload must
   * never see it turn into a failure because a *read-side* readiness check hiccuped after the
   * write succeeded.
   */
  private async awaitSearchIndexConvergence(
    documentVersionId: string,
    tenantId: string,
    chunkCount: number,
    knownChunk: { _id: string; embedding: readonly number[] },
  ): Promise<void> {
    try {
      const [searchOutcome, vectorOutcome] = await Promise.allSettled([
        waitForIndexConvergence(
          this.db,
          EVIDENCE_CHUNKS_COLLECTION,
          SEARCH_INDEX,
          createSearchChunkCountProbe(
            this.db,
            EVIDENCE_CHUNKS_COLLECTION,
            SEARCH_INDEX,
            documentVersionId,
            chunkCount,
          ),
          {
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
            pollIntervalMs: CONVERGENCE_POLL_INTERVAL_MS,
            onTimeout: 'degrade',
          },
        ),
        waitForIndexConvergence(
          this.db,
          EVIDENCE_CHUNKS_COLLECTION,
          VECTOR_INDEX,
          createVectorChunkProbe(
            this.db,
            EVIDENCE_CHUNKS_COLLECTION,
            VECTOR_INDEX,
            tenantId,
            knownChunk._id,
            knownChunk.embedding,
          ),
          {
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
            pollIntervalMs: CONVERGENCE_POLL_INTERVAL_MS,
            onTimeout: 'degrade',
          },
        ),
      ]);

      // Checked individually (search, then vector) rather than combined, so each `if` narrows its
      // own outcome to `fulfilled` for the `.value` reads below without a cast. Reports only the
      // first rejection found — a single warning is enough signal for a best-effort nudge, and the
      // common case (the convergence helper itself throwing) rejects both sides with the same
      // reason anyway.
      if (searchOutcome.status === 'rejected') {
        this.logger.warn(
          `Document version '${documentVersionId}' search index convergence check failed: ` +
            describeError(searchOutcome.reason),
        );
        return;
      }
      if (vectorOutcome.status === 'rejected') {
        this.logger.warn(
          `Document version '${documentVersionId}' search index convergence check failed: ` +
            describeError(vectorOutcome.reason),
        );
        return;
      }

      const searchResult = searchOutcome.value;
      const vectorResult = vectorOutcome.value;

      if (!searchResult.converged || !vectorResult.converged) {
        this.logger.warn(
          `Document version '${documentVersionId}' search index convergence timed out after ` +
            `${CONVERGENCE_TIMEOUT_MS}ms (search converged: ${searchResult.converged}, vector ` +
            `converged: ${vectorResult.converged}); serving stale search results until Atlas catches up`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Document version '${documentVersionId}' search index convergence check failed: ` +
          describeError(error),
      );
    }
  }

  /**
   * Fails CLOSED: only succeeds (and overwrites the lease) while the version is not yet
   * `completed` — a concurrent attempt that already finished this version leaves nothing to
   * claim, so the recovery `deleteMany` below never runs against a version another attempt owns.
   *
   * `{ $ne: 'completed' }` also re-claims a `'failed'` version, so a retried attempt (a new
   * Temporal run, not the automatic in-workflow retries `maximumAttempts` already exhausted) can
   * ingest it again. That retry only ever comes from new bytes: `DocumentsService.addVersion`
   * dedupes a byte-identical re-upload onto the existing version by sha256 without starting a new
   * ingestion workflow, so a `'failed'` version stays `'failed'` until different bytes arrive.
   */
  private async claimAttempt(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
  ): Promise<boolean> {
    const claimed = await this.documentVersionModel.findOneAndUpdate(
      { _id: versionId, ingestionStatus: { $ne: 'completed' } },
      { $set: { ingestionLeaseToken: leaseToken } },
    );
    return claimed !== null;
  }

  /** Fails CLOSED: only succeeds while `leaseToken` is still the current one — if a newer attempt
   * has since claimed the version, this attempt's writes are stale and the caller must roll them
   * back rather than mark the version `completed` out from under the newer attempt. */
  private async finalizeCompletion(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
  ): Promise<boolean> {
    const finalized = await this.documentVersionModel.findOneAndUpdate(
      { _id: versionId, ingestionLeaseToken: leaseToken },
      { $set: { ingestionStatus: 'completed' }, $unset: { ingestionLeaseToken: '' } },
    );
    return finalized !== null;
  }

  /**
   * Mirrors `finalizeCompletion`'s compare-and-set exactly, so a parse failure is recorded under
   * the same lease guard as a success: only while `leaseToken` is still the current one, or a
   * stale attempt's failure write could overwrite a newer attempt's in-progress or already-
   * completed state.
   */
  private async finalizeFailure(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
    reason: string,
  ): Promise<boolean> {
    const finalized = await this.documentVersionModel.findOneAndUpdate(
      { _id: versionId, ingestionLeaseToken: leaseToken },
      {
        $set: { ingestionStatus: 'failed', ingestionFailureReason: reason },
        $unset: { ingestionLeaseToken: '' },
      },
    );
    return finalized !== null;
  }

  /**
   * Records `ingestionStatus: 'failed'` for ANY throw reaching `ingestVersion`'s outer catch, not
   * only a `BaseException` from a parser — a plain `Error`, a `RangeError`, an embedding-provider
   * failure, or a Mongo write failure all leave the version as diagnosable as a caught parser
   * exception, rather than stuck at `'pending'` with a live lease token and a dedupe path that
   * silently swallows any byte-identical retry.
   *
   * FAILURE DIRECTION: fails OPEN. This is bookkeeping around the real failure, not the failure
   * itself — if the write here throws, or `finalizeFailure` reports itself superseded by a newer
   * attempt's lease, that outcome is logged and swallowed so `ingestVersion`'s caller always sees
   * the original error, never one masked by a recording failure.
   */
  private async recordIngestionFailure(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
    documentVersionId: string,
    error: unknown,
  ): Promise<void> {
    // Counts the failure itself, not whether the bookkeeping write below succeeds — matches this
    // method's own FAIL OPEN direction: the run genuinely failed regardless of whether recording
    // that fact in Mongo also succeeds.
    workflowRunFailedCounter.add(1);
    try {
      const recorded = await this.finalizeFailure(versionId, leaseToken, describeError(error));
      if (!recorded) {
        this.logger.debug(
          `Document version '${documentVersionId}' failure recording superseded by a newer attempt`,
        );
      }
    } catch (recordingError) {
      this.logger.warn(
        `Document version '${documentVersionId}' failed to record ingestion failure: ` +
          describeError(recordingError),
      );
    }
  }

  /** Scoped by `(documentVersionId, ingestionAttemptToken)`, not by `_id`: a deterministic chunk
   * id (`computeChunkId`) means two concurrent attempts over the same version's bytes compute the
   * *same* ids, so an id-scoped delete here would remove a concurrent winning attempt's rows the
   * instant this attempt's own write lost that race. Scoping by this attempt's own lease token
   * instead guarantees the delete only ever touches rows this attempt wrote. `tenantId` is an
   * additional predicate, not a substitute — it keeps the delete inside the caller's own tenant. */
  private async rollbackChunks(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
    tenantId: string,
  ): Promise<void> {
    await this.evidenceChunkModel.deleteMany({
      documentVersionId: versionId,
      ingestionAttemptToken: leaseToken,
      tenantId,
    });
  }
}
