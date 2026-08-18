import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

/** Which surface the audited action reached the system through: `'api'` for the interactive REST
 * path and every non-MCP caller (worker activities, the eval harness), `'mcp'` for an action taken
 * inside an MCP `tools/call` scope. Same vocabulary as
 * `RequestConflictResolutionInput.origin`/`ResolveConflictWorkflowInput.requestedByOrigin`, so
 * "a person did this" and "an AI client holding a PAT did this" read the same way everywhere. */
export type AuditEventOrigin = 'api' | 'mcp';

export const AUDIT_EVENT_ORIGINS: readonly AuditEventOrigin[] = ['api', 'mcp'];

/** `entityType`/`entityId`, not `type`/`id`: Mongoose treats a nested-object field literally
 * named `type` as ambiguous with its own `{ type: ... }` SchemaType syntax. */
export interface AuditEventSubject {
  entityType: string;
  entityId: Types.ObjectId;
}

export type AuditEventDocument = HydratedDocument<WithTimestamps<AuditEvent>>;

// Append-only: nothing in this codebase runs `findOneAndUpdate`/`updateOne` against this
// collection, so `updatedBy` (from AuditableDocument) is expected to always equal `createdBy`.
// `actor` below is a distinct, domain-level field — who performed the audited `action` — which
// is not always the same principal as whoever's request context wrote the record (e.g. a
// background job auditing an action taken on a user's behalf).
@Schema({ timestamps: true, collection: 'audit_events' })
export class AuditEvent extends AuditableDocument {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actor: Types.ObjectId;

  @Prop({ type: String, required: true })
  action: string;

  @Prop({
    type: {
      entityType: { type: String, required: true },
      entityId: { type: Types.ObjectId, required: true },
    },
    required: true,
  })
  subject: AuditEventSubject;

  @Prop({ type: Date, required: true })
  timestamp: Date;

  @Prop({ type: String, required: true })
  correlationId: string;

  @Prop({ type: String, required: true, enum: AUDIT_EVENT_ORIGINS, default: 'api' })
  origin: AuditEventOrigin;

  /** The tool name an `mcp.tool_call.*` action was made against, set only on rows written at the
   * MCP `tools/call` boundary. Model-controlled and stored verbatim — an unrecognized name is a
   * refused probe worth keeping, so it is never clamped to the advertised tool set. */
  @Prop({ type: String })
  toolName?: string;

  /** Why an `mcp.tool_call.refused` row was refused — a `ToolRefusalReason` from the chokepoint's
   * own closed set, never the refusal's `detail` string: that detail echoes the model-supplied
   * arguments, which do not belong in the audit log. */
  @Prop({ type: String })
  refusalReason?: string;

  /** How many rows a bulk write action actually touched, set only on rows recording that class of
   * action (`sources.class_drift_applied` is the first). Absent on every row that audits a
   * single-entity action, where `subject` alone already says what changed. */
  @Prop({ type: Number })
  modifiedCount?: number;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);
