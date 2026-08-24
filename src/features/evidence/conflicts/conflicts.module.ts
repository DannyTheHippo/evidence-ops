import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentSchema,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  Approval,
  ApprovalSchema,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { FactsModule } from '../facts/facts.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { ConflictsController } from './conflicts.controller';
import { ConflictsService } from './conflicts.service';
import { MetricPackPreviewController } from './metric-pack-preview.controller';
import { ResolutionBacktestService } from './resolution-backtest.service';

// `ProvidersModule` import is for `WORKFLOW_ENGINE`, `WorkflowRunsModule` for
// `WorkflowRunsService` — both `ConflictsService.requestResolution` needs (see its own doc
// comment and `WorkflowRunsModule`'s own comment naming this as the expected consumer).
// `FactsModule` is for its exported `MetricPoliciesService` and `MetricPacksService` —
// `ConflictsService` reads a tenant's resolved survivorship policy and active metric pack through
// them rather than registering `MetricPolicy`/`MetricPack` here itself.
// `Document`/`DocumentVersion` are for `ConflictsService`'s survivorship-proposal lookup —
// resolving each disagreeing fact's `sourceClass` for `resolveConflictPolicy`. `Approval` is for
// `requestResolution`'s own pending-duplicate guard — a read-only check against the same
// collection `MongoApprovalChannel` writes, not a second writer of it.
// `MetricPackPreviewController` is registered here rather than on `FactsModule` — its route lives
// under `/metric-packs`, but `previewPackActivation` belongs on `ConflictsService`, and
// `FactsModule` cannot import this module back without a cycle (see that controller's own doc
// comment).
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: Document.name, schema: DocumentSchema },
      { name: Approval.name, schema: ApprovalSchema },
    ]),
    ProvidersModule,
    FactsModule,
    WorkflowRunsModule,
  ],
  controllers: [ConflictsController, MetricPackPreviewController],
  providers: [ConflictsService, ResolutionBacktestService],
  exports: [ConflictsService],
})
export class ConflictsModule {}
