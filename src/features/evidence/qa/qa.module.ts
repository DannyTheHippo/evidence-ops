import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { AnswerPersistenceService } from './answer-persistence.service';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { GroundingGateService } from './grounding-gate.service';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { SynthesisService } from './synthesis.service';

// `GroundingGateService` has no Mongoose/model dependency of its own (see its doc comment: it
// verifies, never queries) and needs no `ProvidersModule` import. `SynthesisService` needs it for
// `MODEL_PROVIDER`; `EvidenceRetrievalService` needs it for `RETRIEVAL_STORE`. `QaService` reuses
// the same `Answer` model registration and `ProvidersModule` import for `WORKFLOW_ENGINE`.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
    ]),
    ProvidersModule,
  ],
  controllers: [QaController],
  providers: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    AnswerPersistenceService,
    QaService,
  ],
  exports: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    AnswerPersistenceService,
    QaService,
  ],
})
export class QaModule {}
