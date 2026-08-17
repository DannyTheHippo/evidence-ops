import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type ModelSpendWindowDocument = HydratedDocument<WithTimestamps<ModelSpendWindow>>;

/**
 * One row per `(tenantId, windowStart)` pair, tracking aggregate model spend within that window.
 * `reservedUsd` holds the sum of in-flight reservations not yet settled; `spentUsd` holds the sum
 * of actual cost for calls that have settled. `TenantSpendService` reads both together as the
 * live commitment against a tenant's daily ceiling, so a burst of concurrent calls cannot each
 * pass a budget check that only looked at `spentUsd`.
 */
@Schema({ timestamps: true, collection: 'model_spend_windows' })
export class ModelSpendWindow extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: Date, required: true })
  windowStart: Date;

  @Prop({ type: Number, required: true, default: 0 })
  spentUsd: number;

  @Prop({ type: Number, required: true, default: 0 })
  reservedUsd: number;
}

export const ModelSpendWindowSchema = SchemaFactory.createForClass(ModelSpendWindow);
