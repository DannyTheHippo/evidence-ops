import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { FactKey } from '../extracted-fact/extracted-fact.schema';

export type ConflictStatus = 'open' | 'resolved' | 'dismissed';

export const CONFLICT_STATUSES: readonly ConflictStatus[] = ['open', 'resolved', 'dismissed'];

export type ConflictDocument = HydratedDocument<WithTimestamps<Conflict>>;

const MIN_CONFLICTING_FACTS = 2;

@Schema({ timestamps: true, collection: 'conflicts' })
export class Conflict extends AuditableDocument {
  @Prop({
    type: {
      entity: { type: String, required: true, trim: true },
      metric: { type: String, required: true, trim: true },
      period: { type: String, required: true, trim: true },
    },
    required: true,
  })
  factKey: FactKey;

  // A conflict is by definition a disagreement between two or more facts — one fact cannot
  // conflict with itself. Data-integrity gate, fails closed: rejects the document rather than
  // silently persisting a degenerate "conflict" of one.
  @Prop({
    type: [{ type: Types.ObjectId, ref: 'ExtractedFact' }],
    required: true,
    validate: {
      validator: (v: Types.ObjectId[]) => Array.isArray(v) && v.length >= MIN_CONFLICTING_FACTS,
      message: `A conflict requires at least ${MIN_CONFLICTING_FACTS} disagreeing ExtractedFact references`,
    },
  })
  factIds: Types.ObjectId[];

  @Prop({ type: Number, required: true, min: 0 })
  magnitude: number;

  @Prop({ type: String, required: true, enum: CONFLICT_STATUSES, default: 'open' })
  status: ConflictStatus;

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const ConflictSchema = SchemaFactory.createForClass(Conflict);
