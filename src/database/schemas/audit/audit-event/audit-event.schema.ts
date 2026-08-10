import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

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

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);
