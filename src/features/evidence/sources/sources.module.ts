import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Source, SourceSchema } from '../../../database/schemas/evidence/source/source.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { DocumentsModule } from '../documents/documents.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { EvidenceSubmissionService } from './evidence-submission.service';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

/**
 * `ProvidersModule` is for `SOURCE_CONNECTOR`/`WORKFLOW_ENGINE`, `WorkflowRunsModule` for
 * `WorkflowRunsService` (`SourcesService.requestSync` records the same durable `WorkflowRun`
 * projection `ConflictsService.requestResolution` does), and `DocumentsModule` for
 * `DocumentsService` — `SourcesService.runSync` uploads a synced file's bytes through the exact
 * same content-addressed, ingestion-workflow-starting path a manual upload uses, rather than
 * duplicating it. `EvidenceSubmissionService` lives here rather than in `documents/` because it
 * also owns the `Source` model this module already imports for `mcp-submit` rows.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Source.name, schema: SourceSchema }]),
    ProvidersModule,
    WorkflowRunsModule,
    DocumentsModule,
  ],
  controllers: [SourcesController],
  providers: [SourcesService, EvidenceSubmissionService],
  exports: [SourcesService, EvidenceSubmissionService],
})
export class SourcesModule {}
