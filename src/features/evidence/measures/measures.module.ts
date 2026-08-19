import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { MeasuresController } from './measures.controller';
import { MeasuresService } from './measures.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
    ]),
  ],
  controllers: [MeasuresController],
  providers: [MeasuresService],
})
export class MeasuresModule {}
