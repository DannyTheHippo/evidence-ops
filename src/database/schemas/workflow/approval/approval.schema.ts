import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'timed_out';

export const APPROVAL_STATES: readonly ApprovalState[] = [
  'pending',
  'approved',
  'rejected',
  'timed_out',
];

/** `entityType`/`entityId`, not `type`/`id`: mirrors `AuditEventSubject`
 * (`audit-event.schema.ts`) — a nested field literally named `type` is ambiguous with Mongoose's
 * own `{ type: ... }` SchemaType syntax. Generic rather than a `Conflict`-only or
 * `WorkflowRun`-only reference: D2's `resolveConflict` workflow gates on a `Conflict`, but a
 * later approval could just as easily gate a `WorkflowRun` (or another entity) — one collection
 * with a discriminated subject serves both without a schema migration per subject kind. */
export interface ApprovalSubject {
  entityType: string;
  entityId: Types.ObjectId;
}

export type ApprovalDocument = HydratedDocument<WithTimestamps<Approval>>;

// D1 of the approvals milestone: persistence only. `workflowId` is a plain string, not a typed
// Temporal handle, matching `WorkflowRun.workflowId` — same reasoning: no compile-time dependency
// on `@temporalio/*` from database code. `requestedBy`/`decidedBy` are opaque strings (an email,
// a service principal), not `ObjectId` refs to `User` — `ApprovalChannel.requestApproval`'s
// `requestedBy` field is already typed `string` at the provider boundary, and this schema stores
// exactly what that boundary hands it rather than forcing a cast that could throw on a
// non-Mongo-id caller. `createdBy`/`updatedBy` (from `AuditableDocument`) stay unset in practice:
// `auditablePlugin` reads AsyncLocalStorage, and a Temporal activity runs with no ALS store (see
// `mongoose.md`'s audit-stamp caveat) — the same distinction `AuditEvent.actor` already documents
// between "who acted" and "whose request context wrote the row".
@Schema({ timestamps: true, collection: 'approvals' })
export class Approval extends AuditableDocument {
  @Prop({
    type: {
      entityType: { type: String, required: true, trim: true },
      entityId: { type: Types.ObjectId, required: true },
    },
    required: true,
  })
  subject: ApprovalSubject;

  @Prop({ type: String })
  workflowId?: string;

  @Prop({ type: String, required: true, trim: true })
  action: string;

  @Prop({ type: String, required: true, trim: true })
  summary: string;

  @Prop({ type: String })
  requestedBy?: string;

  @Prop({ type: String, required: true, enum: APPROVAL_STATES, default: 'pending' })
  state: ApprovalState;

  @Prop({ type: String })
  decidedBy?: string;

  @Prop({ type: Date })
  decidedAt?: Date;

  @Prop({ type: String })
  decisionReason?: string;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const ApprovalSchema = SchemaFactory.createForClass(Approval);

/**
 * Every real query already filters by `{tenantId, state}` (`ListApprovalsRequestDto.state`
 * defaults to `'pending'`), which `migrations/0001-baseline.ts`'s
 * `approvals_tenantId_state_createdAt` already serves. This index backs a query that scopes by
 * `tenantId` and sorts by `createdAt` alone, for a caller that queries without a state filter.
 */
ApprovalSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'approvals_tenantId_createdAt' });

/** Backs `GET /approvals?sort=decidedAt` — the one allowlisted sort field with no existing
 *  `{tenantId, ...}` prefix to ride. */
ApprovalSchema.index({ tenantId: 1, decidedAt: 1 }, { name: 'approvals_tenantId_decidedAt' });
