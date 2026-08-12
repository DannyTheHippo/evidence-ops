import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Source, SourceSchema } from '../../../database/schemas/evidence/source/source.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { DocumentsModule } from '../documents/documents.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { SourcesService } from './sources.service';

/**
 * `ProvidersModule` is for `SOURCE_CONNECTOR`/`WORKFLOW_ENGINE`, `WorkflowRunsModule` for
 * `WorkflowRunsService` (`SourcesService.requestSync` records the same durable `WorkflowRun`
 * projection `ConflictsService.requestResolution` does), and `DocumentsModule` for
 * `DocumentsService` — `SourcesService.runSync` uploads a synced file's bytes through the exact
 * same content-addressed, ingestion-workflow-starting path a manual upload uses, rather than
 * duplicating it.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Source.name, schema: SourceSchema }]),
    ProvidersModule,
    WorkflowRunsModule,
    DocumentsModule,
  ],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}
