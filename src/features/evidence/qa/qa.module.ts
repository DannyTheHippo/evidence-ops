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
import {
  EvidenceChunk,
  EvidenceChunkSchema,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { ConflictsModule } from '../conflicts/conflicts.module';
import { FactsModule } from '../facts/facts.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MeasuresModule } from '../measures/measures.module';
import { VerificationsModule } from '../verifications/verifications.module';
import { AnswerPersistenceService } from './answer-persistence.service';
import { ClaimDecompositionService } from './claim-decomposition.service';
import { ClaimVerificationService } from './claim-verification.service';
import { ContradictionCheckService } from './contradiction-check.service';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { GroundingGateService } from './grounding-gate.service';
import { LedgerAnswerService } from './ledger-answer.service';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { QuestionResolverService } from './question-resolver.service';
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
// raw-chunk-text numeric matching when a cited chunk has zero cell facts. `FactsModule` also
// exports `CanonicalEntityService`, which `ClaimVerificationService` needs directly — `FactsModule`
// exports only that and `FactsService`, never `MeasuresService`, so `MeasuresModule` is imported
// separately for `MeasuresService.listConfirmedDefinitions`. `VerificationsModule` is for
// `VerificationsService.record`, the persistence `ClaimVerificationService.verifyClaims` calls once
// per run. `ExtractedFact`/`EvidenceChunk` are registered here (alongside the already-present
// `DocumentVersion`) for `LedgerAnswerService`'s own representative-fact/chunk/version loads;
// `LedgerModule` is imported for `LedgerService.resolveValue`.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: Document.name, schema: DocumentSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ProvidersModule,
    FactsModule,
    ConflictsModule,
    LedgerModule,
    MeasuresModule,
    VerificationsModule,
  ],
  controllers: [QaController],
  providers: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    QueryEmbeddingCacheService,
    AnswerPersistenceService,
    ClaimDecompositionService,
    ContradictionCheckService,
    ClaimVerificationService,
    QaService,
    QuestionResolverService,
    LedgerAnswerService,
  ],
  exports: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    AnswerPersistenceService,
    ClaimVerificationService,
    QaService,
    QuestionResolverService,
    LedgerAnswerService,
  ],
})
export class QaModule {}
