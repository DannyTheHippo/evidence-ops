import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  Document,
  DocumentDocument,
  type DocumentSourceClass,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../../../providers/embedding/embedding-provider.interface';
import type { HybridRetrievalHitMetadata } from '../../../providers/retrieval/mongo-hybrid.store';
import {
  RETRIEVAL_STORE,
  type RetrievalStore,
} from '../../../providers/retrieval/retrieval-store.interface';
import {
  emptyRetrievalCounter,
  scoreFloorRejectedAllCounter,
} from '../../../providers/telemetry/domain-metrics';
import type { SortDirection } from '../../../shared/constants/sort.constant';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  MAX_RETRIEVAL_STORE_LIMIT,
  RETRIEVAL_OVER_FETCH_MULTIPLIER,
} from '../retrieval/retrieval.constant';
import { QueryEmbeddingCacheService } from './query-embedding-cache.service';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export interface RetrieveEvidenceInput {
  readonly questionText: string;
  readonly tenantId: string;
}

/** `documentId`/`sourceClass`/date-range filters all resolve on `Document`, never on
 *  `evidence_chunks` — see `SearchEvidenceInput`'s own doc comment for why that forces every one
 *  of them to apply after fusion rather than inside `$search`/`$vectorSearch`. Both date bounds
 *  are inclusive. */
export interface RetrieveEvidenceFilter {
  readonly documentId?: string;
  readonly sourceClass?: DocumentSourceClass;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
}

/**
 * Input to `EvidenceRetrievalService.searchEvidence`, the paged/filtered/sorted counterpart to
 * `retrieve` behind `GET /retrieval/search`. `filter` applies after fusion because `documentId`,
 * `sourceClass` and the date range all live on `Document`, not on the indexed `evidence_chunks`
 * collection `$search`/`$vectorSearch` run against, and neither index exposes a cross-collection
 * join. `skip`/`limit` apply after that filter and after the withdrawn-version drop, in that
 * order — never before either, or a page boundary would silently include documents this request
 * was never meant to see.
 */
export interface SearchEvidenceInput {
  readonly questionText: string;
  readonly tenantId: string;
  readonly skip: number;
  readonly limit: number;
  readonly sortDirection: SortDirection;
  readonly filter: RetrieveEvidenceFilter;
}

export interface SearchEvidenceResult {
  readonly chunks: RetrievedChunk[];
  /**
   * Whether the ranked, filtered result set holds at least one more chunk beyond this page.
   * There is no total: the store over-fetches and slices back non-deterministically between
   * runs, the score floor drops hits after fusion, and withdrawn versions are dropped after
   * fusion too — so a match count would have to be computed fresh per request and would still
   * disagree between two identical calls. `hasMore` is the same best-effort signal, not a
   * stronger guarantee — a filter can legitimately leave a page short of `limit` with `hasMore`
   * still true, and the over-fetched pool underlying it can itself vary run to run.
   */
  readonly hasMore: boolean;
}

interface RetrievedChunkJoin {
  readonly chunk: RetrievedChunk;
  readonly document: DocumentDocument;
  readonly score: number;
}

/**
 * Adapts `RetrievalStore` output (a generic `RetrievalHit`, id + metadata) into the
 * `RetrievedChunk` shape `GroundingGateService` needs to check citation containment
 * field-by-field. `sha256` isn't on `EvidenceChunk` or the store's hit metadata at all — it lives
 * on `DocumentVersion` (content-addressing, see that schema) — so this service is the one place
 * that joins a retrieval hit back to its version's hash before a citation can be built against it.
 * The same join also resolves `documentTitle`, `sourceClass` and `documentCreatedAt` off
 * `Document`, for callers (the retrieval endpoint, the MCP `search_evidence` tool) that display a
 * hit's source rather than only citing it.
 */
@Injectable()
export class EvidenceRetrievalService {
  constructor(
    @Inject(RETRIEVAL_STORE)
    private readonly retrievalStore: RetrievalStore,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,

    private readonly queryEmbeddingCache: QueryEmbeddingCacheService,

    private readonly config: TypedConfigService,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(EvidenceRetrievalService.name);
  }

  async retrieve(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]> {
    const joined = await this.retrieveAndJoin(
      input.questionText,
      input.tenantId,
      // Widens both the store's candidate pool and the `$vectorSearch` `numCandidates` it
      // derives from `limit`, so a withdrawn chunk doesn't shrink the caller's requested result
      // count as long as enough live chunks exist in the wider pool.
      this.config.retrieval.limit * RETRIEVAL_OVER_FETCH_MULTIPLIER,
    );

    // Restores the caller's requested count after the over-fetch above.
    const chunks = joined.slice(0, this.config.retrieval.limit).map((entry) => entry.chunk);

    if (chunks.length === 0) {
      emptyRetrievalCounter.add(1);
    }

    return chunks;
  }

  /**
   * Paged, filtered, sorted evidence search for `GET /retrieval/search`. Shares fetch/fusion/
   * score-floor/withdrawn-drop with `retrieve` via `retrieveAndJoin`; what's specific here is the
   * page-shaped surface described on `SearchEvidenceInput`/`SearchEvidenceResult`.
   */
  async searchEvidence(input: SearchEvidenceInput): Promise<SearchEvidenceResult> {
    // Sized off the caller's own skip/limit rather than `config.retrieval.limit` — a deep page
    // needs a wider pool to reach it — but capped independently of how large `skip + limit`
    // grows, so a large `skip` cannot inflate the store's pipeline and `$vectorSearch` candidate
    // counts without bound (see `MAX_RETRIEVAL_STORE_LIMIT`'s own doc comment).
    const storeLimit = Math.min(
      (input.skip + input.limit) * RETRIEVAL_OVER_FETCH_MULTIPLIER,
      MAX_RETRIEVAL_STORE_LIMIT,
    );

    const joined = await this.retrieveAndJoin(input.questionText, input.tenantId, storeLimit);

    const filtered = joined.filter((entry) => this.matchesFilter(entry.document, input.filter));

    const sorted = [...filtered].sort((a, b) =>
      input.sortDirection === 'asc' ? a.score - b.score : b.score - a.score,
    );

    const page = sorted.slice(input.skip, input.skip + input.limit).map((entry) => entry.chunk);

    if (page.length === 0) {
      emptyRetrievalCounter.add(1);
    }

    return { chunks: page, hasMore: sorted.length > input.skip + input.limit };
  }

  private matchesFilter(document: DocumentDocument, filter: RetrieveEvidenceFilter): boolean {
    if (filter.documentId !== undefined && !document._id.equals(filter.documentId)) {
      return false;
    }
    if (filter.sourceClass !== undefined && document.sourceClass !== filter.sourceClass) {
      return false;
    }
    if (filter.createdAfter !== undefined && document.createdAt < filter.createdAfter) {
      return false;
    }
    if (filter.createdBefore !== undefined && document.createdAt > filter.createdBefore) {
      return false;
    }
    return true;
  }

  /**
   * Runs the store search, the fail-closed score floor, the version/document joins and the
   * withdrawn-version drop — every step both `retrieve` and `searchEvidence` need identically.
   * Returns the surviving hits already joined to their owning `Document`, unsliced: neither the
   * final result-count cut (`retrieve`) nor the filter/sort/page cut (`searchEvidence`) belongs
   * at this layer, since the two callers apply them differently.
   */
  private async retrieveAndJoin(
    questionText: string,
    tenantId: string,
    storeLimit: number,
  ): Promise<RetrievedChunkJoin[]> {
    const vector = await this.resolveQueryVector(tenantId, questionText);

    // Withdrawn-version exclusion happens here, not in `MongoHybridRetrievalStore`: `$search`'s
    // `compound.filter` takes Atlas Search operators over the indexed collection, with no
    // cross-collection join to reach `document_versions`; `$vectorSearch`'s `filter` only reaches
    // paths declared `type: 'filter'` in the vector index, and today that's `tenantId` alone; and
    // a post-fusion `$match` would land after `$limit`, so a top-k made entirely of withdrawn
    // chunks would come back as zero results with no signal that anything was dropped. Over-fetch
    // and filter here instead, where the withdrawn set is already known from the version lookup
    // below.
    const rawHits = await this.retrievalStore.search<HybridRetrievalHitMetadata>({
      text: questionText,
      vector,
      filter: { tenantId },
      limit: storeLimit,
    });

    // Veto gate over answer availability: fails CLOSED toward abstention, not open toward
    // synthesis. A hit whose fused score does not clear the floor (including a `NaN` score, which
    // fails every comparison) is dropped here, before a chunk is built or a synthesis call is
    // made — an answer produced over evidence that failed its own relevance measurement is worse
    // than one withheld. Every hit `RetrievalStore.search` returns carries a strictly positive
    // fused RRF score (a `1 / (60 + rank)` contribution from at least one pipeline), so a floor of
    // 0 clears every hit and drops none.
    const hits = rawHits.filter((hit) => hit.score >= this.config.retrieval.scoreFloor);

    if (hits.length === 0) {
      // The store returned candidates but every one of them scored below the configured floor —
      // operationally distinct from the corpus itself having nothing relevant, and worth its own
      // signal so a misconfigured floor doesn't read the same as genuine zero-retrieval.
      if (rawHits.length > 0) {
        // No question text here: `warn` reaches shipped log aggregation (unlike the `debug` line
        // below), and the question is user-authored content about a client's confidential data
        // room. `AppLogger.warn` still prefixes the correlation id, which is enough to pair this
        // line up with the `debug` line below in a log search when the raw text is genuinely
        // needed for triage.
        this.logger.warn(
          `Score floor ${this.config.retrieval.scoreFloor} rejected all ${rawHits.length} hit(s) returned for this question`,
        );
        scoreFloorRejectedAllCounter.add(1);
      }
      return [];
    }

    const versionIds = [...new Set(hits.map((hit) => hit.metadata.documentVersionId))];
    // Explicit predicate is load-bearing here: this runs in worker context (Temporal activity),
    // where the ALS-backed `tenantScopePlugin` never ran, so nothing else scopes this query.
    //
    // Deliberately not adding `withdrawnAt: { $exists: false }` to this filter: a version absent
    // from the result below because it was deleted must still fail the `sha256` lookup and throw
    // the data-integrity error further down. A withdrawn version is a normal drop, not corruption —
    // folding it into this filter would make it indistinguishable from a deleted one and silently
    // swallow the signal that throw exists to catch.
    const versions = await this.documentVersionModel.find({
      _id: { $in: versionIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });
    const sha256ByVersionId = new Map(
      versions.map((version) => [version._id.toString(), version.sha256]),
    );
    const withdrawnVersionIds = new Set(
      versions.filter((version) => version.withdrawnAt).map((version) => version._id.toString()),
    );

    // Same shape as the version lookup above, joined on `documentId` instead of
    // `documentVersionId`: a document's title outlives any one version, so it is not on
    // `DocumentVersion` at all.
    const documentIds = [...new Set(hits.map((hit) => hit.metadata.documentId))];
    const documents = await this.documentModel.find({
      _id: { $in: documentIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });
    const documentById = new Map(documents.map((document) => [document._id.toString(), document]));

    this.logger.debug(
      `Retrieved ${hits.length} chunk(s) across ${versionIds.length} document version(s) for question '${questionText}'`,
    );

    return hits
      .filter((hit) => !withdrawnVersionIds.has(hit.metadata.documentVersionId))
      .map((hit): RetrievedChunkJoin => {
        const sha256 = sha256ByVersionId.get(hit.metadata.documentVersionId);
        if (!sha256) {
          // Data-integrity fault, not a normal input-validation branch — mirrors
          // `IngestionService.ingestVersion`'s `documentStore.get` miss and `DocumentsService
          // .assertCurrentVersion`: a retrieval hit only ever carries a `documentVersionId` the
          // hybrid store read straight off a persisted `EvidenceChunk`, so a miss here means the
          // owning `DocumentVersion` was deleted out from under still-indexed chunks.
          throw new InternalServerErrorException(
            `Evidence chunk '${hit.id}' references document version '${hit.metadata.documentVersionId}', which no longer exists`,
          );
        }

        const document = documentById.get(hit.metadata.documentId);
        if (!document) {
          // Same data-integrity fault as the sha256 case above, on the document rather than the
          // version: a retrieval hit only ever carries a `documentId` the hybrid store read
          // straight off a persisted `EvidenceChunk`, so a miss here means the owning `Document`
          // was deleted out from under still-indexed chunks.
          throw new InternalServerErrorException(
            `Evidence chunk '${hit.id}' references document '${hit.metadata.documentId}', which no longer exists`,
          );
        }

        return {
          chunk: {
            chunkId: hit.id,
            docVersionId: hit.metadata.documentVersionId,
            sha256,
            text: hit.metadata.text,
            locator: hit.metadata.locator,
            score: hit.score,
            documentId: hit.metadata.documentId,
            documentTitle: document.title,
            sourceClass: document.sourceClass,
            documentCreatedAt: document.createdAt,
          },
          document,
          score: hit.score,
        };
      });
  }

  /**
   * Resolves the query embedding through `QueryEmbeddingCacheService`, keyed by tenant + query
   * text + this provider's model — a repeated identical question spends one live embedding, not
   * one per call. Passing the result as `RetrievalQuery.vector` is what lets a cache hit skip
   * `MongoHybridRetrievalStore`'s own embedding call entirely; that store only embeds when
   * `vector` is absent.
   */
  private async resolveQueryVector(
    tenantId: string,
    questionText: string,
  ): Promise<readonly number[]> {
    return this.queryEmbeddingCache.getOrCompute(
      { tenantId, text: questionText, model: this.embeddingProvider.info.model },
      () => this.embedQuery(questionText),
    );
  }

  private async embedQuery(text: string): Promise<readonly number[]> {
    // `input_type: 'query'` (not `'document'`, which `IngestionService` uses to embed chunks) is
    // Voyage's asymmetric-embedding parameter — using the wrong side degrades retrieval quality
    // without ever raising an error, so this is the one call site in the app that must pass
    // `'query'`.
    const result = await this.embeddingProvider.embed({ inputs: [text], inputType: 'query' });
    return result.embeddings[0];
  }
}
