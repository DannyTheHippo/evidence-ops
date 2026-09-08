import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Measure, MeasureSchema } from '../../../database/schemas/evidence/measure/measure.schema';
import {
  Verification,
  VerificationSchema,
} from '../../../database/schemas/evidence/verification/verification.schema';
import { AttestationsController } from './attestations.controller';
import { AttestationService } from './attestation.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: Verification.name, schema: VerificationSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: Measure.name, schema: MeasureSchema },
    ]),
  ],
  controllers: [AttestationsController],
  providers: [AttestationService],
  exports: [AttestationService],
})
export class AttestationsModule {}
