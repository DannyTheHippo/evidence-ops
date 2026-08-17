import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
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

/** Which survivorship rule `resolveConflictPolicy` fired for this conflict's facts, captured by
 * `ConflictsService.requestResolution` at approval-request time and carried, unchanged, through
 * `ResolveConflictWorkflowInput` to `ConflictsService.recordResolution` — never recomputed against
 * the conflict's current facts, so a reclassification during the approval wait can't retroactively
 * rewrite what was actually proposed to the reviewer. Absent on a record written before this field
 * existed, and on a `resolveConflict` execution that started before this field existed and only
 * later woke from its approval wait; both leave the record honest ("no provenance was captured"),
 * not a stand-in for `'none'`. */
export type ConflictRuleFired = 'authority' | 'recency' | 'none';

export const CONFLICT_RULES_FIRED: readonly ConflictRuleFired[] = ['authority', 'recency', 'none'];

/** Set once by `ConflictsService.recordResolution` (`resolve-conflict.workflow.ts`'s
 * `recordConflictResolution` activity) — the durable record of the human decision `resolveConflict`
 * gated on. `winningFactId` is set only when `outcome === 'resolved'`; a `rejected`/`timed_out`
 * attempt still gets a `resolution` (so the demo can show *why* a conflict is still `open`), just
 * never a winner, since neither outcome named one. `_id: false` for the same value-object reasoning
 * `FactKeySchema` documents on `ExtractedFact` — one attempt, no independent identity of its own.
 *
 * `ruleFired` and `followedProposal` capture what the survivorship policy proposed at the moment
 * `ConflictsService.requestResolution` asked a human to decide, so a later review can tell whether
 * reviewers trust the rule or routinely override it. `followedProposal` is set only when
 * `outcome === 'resolved'` and a proposal was actually captured at request time (`ruleFired` present
 * and not `'none'`) — a `rejected`/`timed_out` attempt made no winner choice to compare, a `'none'`
 * proposal gave the human nothing to follow, and a record replaying a history from before this
 * capture existed has no proposal to compare against either — all three leave it absent rather than
 * fabricate a `false`. */
export interface ConflictResolution {
  outcome: ConflictResolutionOutcome;
  winningFactId?: Types.ObjectId;
  decidedBy?: string;
  reason?: string;
  resolvedAt: Date;
  ruleFired?: ConflictRuleFired;
  followedProposal?: boolean;
}

const ConflictResolutionSchema = new MongooseSchema<ConflictResolution>(
  {
    outcome: { type: String, required: true, enum: CONFLICT_RESOLUTION_OUTCOMES },
    winningFactId: { type: Types.ObjectId, ref: 'ExtractedFact' },
    decidedBy: { type: String },
    reason: { type: String },
    resolvedAt: { type: Date, required: true },
    ruleFired: { type: String, enum: CONFLICT_RULES_FIRED },
    followedProposal: { type: Boolean },
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

  // Same denormalized grouping key as `ExtractedFact.groupKeyNormalized` — see that field's doc
  // comment. Lets `ConflictsService.scanForConflicts`'s incremental path scope its open-conflict
  // idempotency check to `{tenantId, status, groupKeyNormalized}` instead of the whole tenant.
  @Prop({ type: String, required: true })
  groupKeyNormalized: string;

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

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const ConflictSchema = SchemaFactory.createForClass(Conflict);
