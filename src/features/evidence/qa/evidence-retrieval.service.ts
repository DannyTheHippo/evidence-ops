import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { HybridRetrievalHitMetadata } from '../../../providers/retrieval/mongo-hybrid.store';
import {
  RETRIEVAL_STORE,
  type RetrievalStore,
} from '../../../providers/retrieval/retrieval-store.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export interface RetrieveEvidenceInput {
  readonly questionText: string;
  readonly tenantId?: string;
}

// Wide enough to give `synthesizeAnswer` real cross-document coverage for a typical question
// without ballooning prompt size/cost; the same order of magnitude `PIPELINE_CANDIDATE_MULTIPLIER`
// already applies one layer down in `MongoHybridRetrievalStore`. Revisit once an eval run
// (`eval/`) has data on how coverage trades off against synthesis cost.
const RETRIEVAL_LIMIT = 12;

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

    private readonly logger: AppLogger,
  ) {
    this.logger.init(EvidenceRetrievalService.name);
  }

  async retrieve(input: RetrieveEvidenceInput): Promise<RetrievedChunk[]> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;

    const hits = await this.retrievalStore.search<HybridRetrievalHitMetadata>({
      text: input.questionText,
      filter: { tenantId },
      limit: RETRIEVAL_LIMIT,
    });

    if (hits.length === 0) {
      return [];
    }

    const versionIds = [...new Set(hits.map((hit) => hit.metadata.documentVersionId))];
    const versions = await this.documentVersionModel.find({
      _id: { $in: versionIds.map((id) => new Types.ObjectId(id)) },
    });
    const sha256ByVersionId = new Map(
      versions.map((version) => [version._id.toString(), version.sha256]),
    );

    this.logger.debug(
      `Retrieved ${hits.length} chunk(s) across ${versionIds.length} document version(s) for question '${input.questionText}'`,
    );

    return hits.map((hit) => {
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
    });
  }
}
