import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
];

/**
 * Which workflow a run projects. Covers only the workflows that actually record a run row —
 * `answer-question` and `ingest-document-version` run without one. `workflowId` is a bare
 * `randomUUID()`, so this is the only field carrying what a run *is*.
 *
 * `'rescan-conflicts'` is no longer a workflow this codebase starts. Kept in this closed union
 * for existing rows that carry it; no current code path writes it.
 */
export type WorkflowRunType = 'resolve-conflict' | 'sync-source' | 'rescan-conflicts';

export const WORKFLOW_RUN_TYPES: readonly WorkflowRunType[] = [
  'resolve-conflict',
  'sync-source',
  'rescan-conflicts',
];

export type WorkflowRunDocument = HydratedDocument<WithTimestamps<WorkflowRun>>;

// Projection of Temporal workflow state for the UI to poll/read. Identifiers are plain strings
// rather than typed Temporal handles, so this projection carries no compile-time dependency on
// `@temporalio/*` — the schema layer stays loadable by processes that never boot a worker.
@Schema({ timestamps: true, collection: 'workflow_runs' })
export class WorkflowRun extends AuditableDocument {
  @Prop({ type: String, required: true })
  workflowId: string;

  // Optional because rows written before this field existed carry no type; readers fall back to a
  // generic label rather than treating an older run as malformed.
  @Prop({ type: String, enum: WORKFLOW_RUN_TYPES })
  workflowType?: WorkflowRunType;

  @Prop({ type: String })
  runId?: string;

  @Prop({ type: String, required: true, enum: WORKFLOW_RUN_STATUSES, default: 'queued' })
  status: WorkflowRunStatus;

  @Prop({ type: Types.ObjectId, ref: 'Answer' })
  answerId?: Types.ObjectId;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const WorkflowRunSchema = SchemaFactory.createForClass(WorkflowRun);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same keys, options and
 * names — the migration builds them in a deployed database, these declarations are what
 * `Model.syncIndexes()` builds for a test lane that never runs migrations. Backs
 * `GET /workflow-runs?sort=status|workflowType`, the two allowlisted sort fields with no existing
 * `{tenantId, ...}` prefix to ride.
 */
WorkflowRunSchema.index({ tenantId: 1, status: 1 }, { name: 'workflow_runs_tenantId_status' });
WorkflowRunSchema.index(
  { tenantId: 1, workflowType: 1 },
  { name: 'workflow_runs_tenantId_workflowType' },
);
