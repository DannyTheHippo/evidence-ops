import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import {
  WorkflowRun,
  WorkflowRunSchema,
} from '../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { WorkflowRunsController } from './workflow-runs.controller';
import { WorkflowRunsService } from './workflow-runs.service';

// `ProvidersModule` import is for `WORKFLOW_ENGINE` — `WorkflowRunsService.findById` refreshes the
// durable row against the live engine status (see its own doc comment). `ApprovalsModule` import is
// for `ApprovalsService`, which `streamRun`'s approvals sub-stream reads via `peekPending` — safe
// to import here (no cycle back): `ApprovalsModule` only imports `ProvidersModule` and its own
// Mongoose feature, never this module. `WorkflowRunsService` is exported so `ConflictsModule` can
// inject it (`ConflictsService.requestResolution` is this collection's first writer). `User` is
// registered so `WorkflowRunsService.streamRun` can re-read the connecting user's tenant on each
// `reauthTicks$` tick — see `ApiKeysModule`'s identical `User` registration for the same reason.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkflowRun.name, schema: WorkflowRunSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ProvidersModule,
    ApprovalsModule,
  ],
  controllers: [WorkflowRunsController],
  providers: [WorkflowRunsService],
  exports: [WorkflowRunsService],
})
export class WorkflowRunsModule {}
