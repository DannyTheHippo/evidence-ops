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
import { Measure, MeasureSchema } from '../../../database/schemas/evidence/measure/measure.schema';
import {
  Approval,
  ApprovalSchema,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { ConflictsController } from './conflicts.controller';
import { ConflictsService } from './conflicts.service';

// `ProvidersModule` import is for `WORKFLOW_ENGINE`, `WorkflowRunsModule` for
// `WorkflowRunsService` — both `ConflictsService.requestResolution` needs (see its own doc
// comment and `WorkflowRunsModule`'s own comment naming this as the expected consumer).
// `Document`/`DocumentVersion` are for `ConflictsService`'s survivorship-proposal lookup —
// resolving each disagreeing fact's `sourceClass` for `resolveConflictPolicy`. `Measure` is
// registered here directly — this module's existing pattern for `Document`/`DocumentVersion` —
// rather than by importing the measures feature module: the dependency runs the other way (that
// module imports this one for its confirm-time rescan), so a reverse edge here would create a
// cycle that a `forwardRef` would hide rather than fix. `authorityOrder`/`stalenessWindowMs` come
// from the tenant's confirmed `Measure` rows, loaded once per scan/list/rescan, not a fixed
// ontology constant. `Approval` is for `requestResolution`'s own pending-duplicate guard — a
// read-only check against the same collection `MongoApprovalChannel` writes, not a second writer
// of it.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: Document.name, schema: DocumentSchema },
      { name: Measure.name, schema: MeasureSchema },
      { name: Approval.name, schema: ApprovalSchema },
    ]),
    ProvidersModule,
    WorkflowRunsModule,
  ],
  controllers: [ConflictsController],
  providers: [ConflictsService],
  exports: [ConflictsService],
})
export class ConflictsModule {}
