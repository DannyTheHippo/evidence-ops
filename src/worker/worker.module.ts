import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/config.module';
import { mongooseModuleOptions } from '../config/mongo.config';
import { ApprovalsModule } from '../features/evidence/approvals/approvals.module';
import { ConflictsModule } from '../features/evidence/conflicts/conflicts.module';
import { FactsModule } from '../features/evidence/facts/facts.module';
import { IngestionModule } from '../features/evidence/ingestion/ingestion.module';
import { MeasuresModule } from '../features/evidence/measures/measures.module';
import { QaModule } from '../features/evidence/qa/qa.module';
import { SourcesModule } from '../features/evidence/sources/sources.module';
import { WorkflowRunsModule } from '../features/evidence/workflow-runs/workflow-runs.module';
import { SharedModule } from '../shared/shared.module';

/**
 * Worker-side root module, booted via `NestFactory.createApplicationContext` in `main.ts` so
 * activities resolve real services from the same DI graph as the API process (ADR-0003). Mirrors
 * the slice of `AppModule`'s imports the worker's activities need — config, Mongo, and the
 * request-context/logger providers from `SharedModule`, plus `IngestionModule`, `FactsModule`,
 * `MeasuresModule`, `ConflictsModule`, `QaModule`, `SourcesModule`, `ApprovalsModule`, and
 * `WorkflowRunsModule` for the services `createActivities` resolves — without the HTTP-only
 * concerns (`ThrottlerModule`, filters, versioning, middleware) that only apply to the API
 * process. `MeasuresModule` and `WorkflowRunsModule` are listed explicitly even though other
 * imports also reach them transitively, because `createActivities` resolves `MeasuresService` and
 * `WorkflowRunsService` directly via `app.get`. `ApprovalsModule` supplies
 * `ApprovalsService.expire`, which the `expireApproval` activity calls from `resolveConflict`'s
 * timeout branch.
 */
@Module({
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    SharedModule,
    IngestionModule,
    FactsModule,
    MeasuresModule,
    ConflictsModule,
    QaModule,
    SourcesModule,
    ApprovalsModule,
    WorkflowRunsModule,
  ],
})
export class WorkerModule {}
