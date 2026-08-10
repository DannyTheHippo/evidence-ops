import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { ConflictsController } from './conflicts.controller';
import { ConflictsService } from './conflicts.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
    ]),
  ],
  controllers: [ConflictsController],
  providers: [ConflictsService],
  exports: [ConflictsService],
})
export class ConflictsModule {}
