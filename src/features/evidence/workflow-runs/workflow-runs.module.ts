import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  WorkflowRun,
  WorkflowRunSchema,
} from '../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { WorkflowRunsController } from './workflow-runs.controller';
import { WorkflowRunsService } from './workflow-runs.service';

// `ProvidersModule` import is for `WORKFLOW_ENGINE` — `WorkflowRunsService.findById` refreshes the
// durable row against the live engine status (see its own doc comment). `WorkflowRunsService` is
// exported so `ConflictsModule` can inject it (`ConflictsService.requestResolution` is this
// collection's first writer).
@Module({
  imports: [
    MongooseModule.forFeature([{ name: WorkflowRun.name, schema: WorkflowRunSchema }]),
    ProvidersModule,
  ],
  controllers: [WorkflowRunsController],
  providers: [WorkflowRunsService],
  exports: [WorkflowRunsService],
})
export class WorkflowRunsModule {}
