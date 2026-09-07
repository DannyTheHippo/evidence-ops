import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Measure, MeasureSchema } from '../../../database/schemas/evidence/measure/measure.schema';
import { ConflictsModule } from '../conflicts/conflicts.module';
import { MeasuresController } from './measures.controller';
import { MeasuresService } from './measures.service';

/**
 * Imports `ConflictsModule` for the synchronous rescan `MeasuresService.confirm`/`update` runs on
 * every confirm and edit. The dependency runs one way only: `ConflictsModule` registers the
 * `Measure` model directly (its existing pattern for `Document`/`DocumentVersion`) rather than
 * importing this module, so the graph has no cycle and needs no `forwardRef`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Measure.name, schema: MeasureSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
    ]),
    ConflictsModule,
  ],
  controllers: [MeasuresController],
  providers: [MeasuresService],
  exports: [MeasuresService],
})
export class MeasuresModule {}
