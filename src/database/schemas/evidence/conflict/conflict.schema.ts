import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { FactKey } from '../extracted-fact/extracted-fact.schema';

export type ConflictStatus = 'open' | 'resolved' | 'dismissed';

export const CONFLICT_STATUSES: readonly ConflictStatus[] = ['open', 'resolved', 'dismissed'];

export type ConflictDocument = HydratedDocument<WithTimestamps<Conflict>>;

// Exported so `DocumentsService.remove`'s deletion cascade can gate its own cardinality flip
// (resolve-as-superseded only once a conflict's `factIds` drops below this) against the same
// number this schema's own validator enforces, rather than a second hardcoded `2`.
export const MIN_CONFLICTING_FACTS = 2;

// 'superseded' is reachable ONLY from `DocumentsService.remove`'s deletion cascade — never from
// `ConflictsService.recordResolution`'s human-decision path (`resolveConflict`'s three branches
// stay `resolved` | `rejected` | `timed_out`). It marks a conflict whose disagreeing facts no
// longer exist because their source document was deleted, so there is nothing left to decide.
export type ConflictResolutionOutcome = 'resolved' | 'rejected' | 'timed_out' | 'superseded';

export const CONFLICT_RESOLUTION_OUTCOMES: readonly ConflictResolutionOutcome[] = [
  'resolved',
  'rejected',
  'timed_out',
  'superseded',
];

/** Set once by `ConflictsService.recordResolution` (`resolve-conflict.workflow.ts`'s
 * `recordConflictResolution` activity) — the durable record of the human decision `resolveConflict`
 * gated on. `winningFactId` is set only when `outcome === 'resolved'`; a `rejected`/`timed_out`
 * attempt still gets a `resolution` (so the demo can show *why* a conflict is still `open`), just
 * never a winner, since neither outcome named one. `_id: false` for the same value-object reasoning
 * `FactKeySchema` documents on `ExtractedFact` — one attempt, no independent identity of its own. */
export interface ConflictResolution {
  outcome: ConflictResolutionOutcome;
  winningFactId?: Types.ObjectId;
  decidedBy?: string;
  reason?: string;
  resolvedAt: Date;
}

const ConflictResolutionSchema = new MongooseSchema<ConflictResolution>(
  {
    outcome: { type: String, required: true, enum: CONFLICT_RESOLUTION_OUTCOMES },
    winningFactId: { type: Types.ObjectId, ref: 'ExtractedFact' },
    decidedBy: { type: String },
    reason: { type: String },
    resolvedAt: { type: Date, required: true },
  },
  { _id: false },
);

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

  // Optional, no migration needed (`mongoose.md`: a migration is mandated only for an index or a
  // backfill, and this field needs neither) — absent until `resolveConflict` runs once for this
  // conflict.
  @Prop({ type: ConflictResolutionSchema })
  resolution?: ConflictResolution;

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const ConflictSchema = SchemaFactory.createForClass(Conflict);
