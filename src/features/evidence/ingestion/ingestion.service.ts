import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { chunkElements } from './chunker';
import { computeChunkId } from './compute-chunk-id';
import { DocumentVersionNotFoundException } from './exceptions/ingestion.exception';
import { ParserRegistry } from './parser.registry';
import { screenInstructionInjection } from './screen-instruction-injection';

export interface IngestionResult {
  readonly chunksCreated: number;
  /** True when this call was a no-op because the version was already ingested. */
  readonly alreadyIngested: boolean;
}

@Injectable()
export class IngestionService {
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

    private readonly logger: AppLogger,
  ) {
    this.logger.init(IngestionService.name);
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
  async ingestVersion(documentVersionId: string): Promise<IngestionResult> {
    if (!Types.ObjectId.isValid(documentVersionId)) {
      throw new DocumentVersionNotFoundException(
        `Document version '${documentVersionId}' not found`,
      );
    }

    const version = await this.documentVersionModel.findById(documentVersionId);
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

    // Clean slate for this attempt now that it holds the current lease — anything left behind by
    // an earlier attempt (crashed, or since-superseded) is safe to clear, because that attempt's
    // own `finalizeCompletion` can no longer succeed once this claim has overwritten its token.
    // `deleteMany` against zero matching documents is a cheap, indexed no-op on the ordinary
    // first-ingest path.
    await this.evidenceChunkModel.deleteMany({ documentVersionId: version._id });

    const stored = await this.documentStore.get(version.storageKey);
    if (!stored) {
      // Data-integrity fault, not a normal input-validation branch: `storageKey` is only ever set
      // from a successful `documentStore.put()` (see `DocumentsService`), so a miss here means the
      // store lost bytes it already confirmed writing — mirrors `DocumentsService
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
    // carry no heading path at all, so `chunkProse` treats a whole document as a single run) every
    // page of a PDF. An element is the finest unit a parser produces (`ParsedElement`'s own doc
    // comment), so filtering here is the smallest quarantine the pipeline can express. It is still
    // not free: a PDF page is also the finest unit `PdfPageLocator` can address (`pdf.parser.ts`),
    // so a flagged page's legitimate text on the same page is quarantined along with it.
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
      await this.rollbackChunks(version._id, leaseToken);
      throw error;
    }

    const finalized = await this.finalizeCompletion(version._id, leaseToken);
    if (!finalized) {
      // A newer attempt claimed the lease while this one was embedding/inserting — these rows
      // are stale. Temporal already discards a superseded attempt's return value in favor of the
      // retry that actually finalizes, so the exact result shape here is inert; `alreadyIngested:
      // true` just avoids implying this attempt itself finished the job.
      await this.rollbackChunks(version._id, leaseToken);
      this.logger.debug(
        `Document version '${documentVersionId}' ingest superseded by a newer attempt; rolled back up to ${chunkDocs.length} chunk(s)`,
      );
      return { chunksCreated: 0, alreadyIngested: true };
    }

    this.logger.debug(
      `Document version '${documentVersionId}' ingested into ${chunkDocs.length} chunks`,
    );

    return { chunksCreated: chunkDocs.length, alreadyIngested: false };
  }

  /** Fails CLOSED: only succeeds (and overwrites the lease) while the version is not yet
   * `completed` — a concurrent attempt that already finished this version leaves nothing to
   * claim, so the recovery `deleteMany` below never runs against a version another attempt owns. */
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

  /** Scoped by `(documentVersionId, ingestionAttemptToken)`, not by `_id`: a deterministic chunk
   * id (`computeChunkId`) means two concurrent attempts over the same version's bytes compute the
   * *same* ids, so an id-scoped delete here would remove a concurrent winning attempt's rows the
   * instant this attempt's own write lost that race. Scoping by this attempt's own lease token
   * instead guarantees the delete only ever touches rows this attempt wrote. */
  private async rollbackChunks(
    versionId: Types.ObjectId,
    leaseToken: Types.ObjectId,
  ): Promise<void> {
    await this.evidenceChunkModel.deleteMany({
      documentVersionId: versionId,
      ingestionAttemptToken: leaseToken,
    });
  }
}
