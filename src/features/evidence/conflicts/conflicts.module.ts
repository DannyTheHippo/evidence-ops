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
import { ProvidersModule } from '../../../providers/providers.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { ConflictsController } from './conflicts.controller';
import { ConflictsService } from './conflicts.service';

// `ProvidersModule` import is for `WORKFLOW_ENGINE`, `WorkflowRunsModule` for
// `WorkflowRunsService` — both `ConflictsService.requestResolution` needs (see its own doc
// comment and `WorkflowRunsModule`'s own comment naming this as the expected consumer).
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
    ]),
    ProvidersModule,
    WorkflowRunsModule,
  ],
  controllers: [ConflictsController],
  providers: [ConflictsService],
  exports: [ConflictsService],
})
export class ConflictsModule {}
