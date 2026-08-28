import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Document,
  DocumentSchema,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { ConflictsModule } from '../conflicts/conflicts.module';
import { FactsModule } from '../facts/facts.module';
import { AnswerPersistenceService } from './answer-persistence.service';
import { ClaimVerificationService } from './claim-verification.service';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { GroundingGateService } from './grounding-gate.service';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { QueryEmbeddingCacheService } from './query-embedding-cache.service';
import { SynthesisService } from './synthesis.service';

// `GroundingGateService` has no Mongoose/model dependency of its own (see its doc comment: it
// verifies, never queries) and needs no `ProvidersModule` import. `SynthesisService` needs it for
// `MODEL_PROVIDER`; `EvidenceRetrievalService` needs it for `RETRIEVAL_STORE`. `QaService` reuses
// the same `Answer` model registration and `ProvidersModule` import for `WORKFLOW_ENGINE`. `User`
// is registered so `QaService.streamAnswer` can re-read the connecting user's tenant on each
// `reauthTicks$` tick — see `ApiKeysModule`'s identical `User` registration for the same reason.
// `FactsModule`/`ConflictsModule` are for claim verification's cell-fact and conflict lookups
// (`FactsService.findCellFacts`, `ConflictsService.findConflictedFactGroupsForChunks`) — passing
// an empty `cellFacts` array is not a safe default, since `verify-claim.ts` only falls back to
// raw-chunk-text numeric matching when a cited chunk has zero cell facts.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: Document.name, schema: DocumentSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ProvidersModule,
    FactsModule,
    ConflictsModule,
  ],
  controllers: [QaController],
  providers: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    QueryEmbeddingCacheService,
    AnswerPersistenceService,
    ClaimVerificationService,
    QaService,
  ],
  exports: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    AnswerPersistenceService,
    ClaimVerificationService,
    QaService,
  ],
})
export class QaModule {}
