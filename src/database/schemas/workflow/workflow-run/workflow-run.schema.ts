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

export type WorkflowRunDocument = HydratedDocument<WithTimestamps<WorkflowRun>>;

// Projection of Temporal workflow state for the UI to poll/read. Temporal itself is scaffolded
// but not wired (see CLAUDE.md) — identifiers are plain strings, not a typed Temporal handle, so
// this projection has no compile-time dependency on `@temporalio/*` ahead of the worker existing.
@Schema({ timestamps: true, collection: 'workflow_runs' })
export class WorkflowRun extends AuditableDocument {
  @Prop({ type: String, required: true })
  workflowId: string;

  @Prop({ type: String })
  runId?: string;

  @Prop({ type: String, required: true, enum: WORKFLOW_RUN_STATUSES, default: 'queued' })
  status: WorkflowRunStatus;

  @Prop({ type: String })
  currentStep?: string;

  @Prop({ type: Types.ObjectId, ref: 'Answer' })
  answerId?: Types.ObjectId;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const WorkflowRunSchema = SchemaFactory.createForClass(WorkflowRun);
