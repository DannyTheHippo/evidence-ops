import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { HybridRetrievalHitMetadata } from '../../../providers/retrieval/mongo-hybrid.store';
import {
  RETRIEVAL_STORE,
  type RetrievalStore,
} from '../../../providers/retrieval/retrieval-store.interface';
import {
  emptyRetrievalCounter,
  scoreFloorRejectedAllCounter,
} from '../../../providers/telemetry/domain-metrics';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { RETRIEVAL_OVER_FETCH_MULTIPLIER } from '../retrieval/retrieval.constant';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export interface RetrieveEvidenceInput {
  readonly questionText: string;
  readonly tenantId: string;
}

/**
 * Adapts `RetrievalStore` output (a generic `RetrievalHit`, id + metadata) into the
 * `RetrievedChunk` shape `GroundingGateService` needs to check citation containment
 * field-by-field. `sha256` isn't on `EvidenceChunk` or the store's hit metadata at all — it lives
 * on `DocumentVersion` (content-addressing, see that schema) — so this service is the one place
 * that joins a retrieval hit back to its version's hash before a citation can be built against it.
 */
@Injectable()
export class EvidenceRetrievalService {
  constructor(
    @Inject(RETRIEVAL_STORE)
    private readonly retrievalStore: RetrievalStore,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    private readonly config: TypedConfigService,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(EvidenceRetrievalService.name);
  }

  async retrieve(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]> {
    // Withdrawn-version exclusion happens here, not in `MongoHybridRetrievalStore`: `$search`'s
    // `compound.filter` takes Atlas Search operators over the indexed collection, with no
    // cross-collection join to reach `document_versions`; `$vectorSearch`'s `filter` only reaches
    // paths declared `type: 'filter'` in the vector index, and today that's `tenantId` alone; and
    // a post-fusion `$match` would land after `$limit`, so a top-k made entirely of withdrawn
    // chunks would come back as zero results with no signal that anything was dropped. Over-fetch
    // and filter here instead, where the withdrawn set is already known from the version lookup
    // below.
    const rawHits = await this.retrievalStore.search<HybridRetrievalHitMetadata>({
      text: input.questionText,
      filter: { tenantId: input.tenantId },
      // `RETRIEVAL_OVER_FETCH_MULTIPLIER` widens both the store's candidate pool and the
      // `$vectorSearch` `numCandidates` it derives from `limit`. ANN search is approximate, so the
      // top-k prefix of an over-fetched run is not guaranteed identical to a non-over-fetched
      // one — `recallHitRank` has been observed moving between replays of an identical corpus.
      // That's accepted here, not compensated for.
      limit: this.config.retrieval.limit * RETRIEVAL_OVER_FETCH_MULTIPLIER,
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
      emptyRetrievalCounter.add(1);
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
      tenantId: input.tenantId,
    });
    const sha256ByVersionId = new Map(
      versions.map((version) => [version._id.toString(), version.sha256]),
    );
    const withdrawnVersionIds = new Set(
      versions.filter((version) => version.withdrawnAt).map((version) => version._id.toString()),
    );

    this.logger.debug(
      `Retrieved ${hits.length} chunk(s) across ${versionIds.length} document version(s) for question '${input.questionText}'`,
    );

    const chunks = hits
      .filter((hit) => !withdrawnVersionIds.has(hit.metadata.documentVersionId))
      .map((hit) => {
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

        return {
          chunkId: hit.id,
          docVersionId: hit.metadata.documentVersionId,
          sha256,
          text: hit.metadata.text,
          locator: hit.metadata.locator,
        };
      })
      // Restores the caller's requested count after the over-fetch above.
      .slice(0, this.config.retrieval.limit);

    if (chunks.length === 0) {
      emptyRetrievalCounter.add(1);
    }

    return chunks;
  }
}
