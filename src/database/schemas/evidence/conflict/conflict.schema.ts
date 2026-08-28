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
//
// 'retracted' marks a machine-dismissed conflict rather than a human decision — `status` becomes
// `'dismissed'`, not `'resolved'`, so a machine retraction never inflates a measure of human
// decisions. Written by `ConflictsService.detectAndPersist`'s `findRetractableConflicts`: an
// `open` conflict whose group's current facts stop disagreeing on a later scan (a corrected
// re-upload, most commonly) is closed this way rather than left open forever.
export type ConflictResolutionOutcome =
  'resolved' | 'rejected' | 'timed_out' | 'superseded' | 'retracted';

export const CONFLICT_RESOLUTION_OUTCOMES: readonly ConflictResolutionOutcome[] = [
  'resolved',
  'rejected',
  'timed_out',
  'superseded',
  'retracted',
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
 * fabricate a `false`.
 *
 * `packId`/`packVersion` are set only on a historical `outcome === 'retracted'` row — the metric
 * ontology in force at the moment a machine retraction decided the conflict's disagreement no
 * longer cleared its tolerance, so a reviewer reading a retracted row can tell which ontology
 * caused it without cross-referencing the audit log. */
export interface ConflictResolution {
  outcome: ConflictResolutionOutcome;
  winningFactId?: Types.ObjectId;
  decidedBy?: string;
  reason?: string;
  resolvedAt: Date;
  ruleFired?: ConflictRuleFired;
  followedProposal?: boolean;
  packId?: string;
  packVersion?: number;
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
    packId: { type: String },
    packVersion: { type: Number },
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

  /**
   * The unit `magnitude` is expressed in — the metric's `canonicalUnit` in force when
   * `detectConflicts` computed this row's `max - min` spread, not a fixed unit for the collection.
   * A stored `0.0085` is 85 basis points only because `cap_rate`'s canonical unit is a ratio;
   * without this field nothing on the row records that. Required, not optional, for the same
   * reason `packId`/`packVersion` are: see those fields' comment.
   */
  @Prop({ type: String, required: true })
  magnitudeUnit: string;

  /**
   * The metric ontology (`metric-ontology.ts`'s `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION`) in force
   * when `ConflictsService.scanForConflicts` detected this conflict. Required for the same reason
   * `ExtractedFact.packId`/`packVersion` are — see that schema's own doc comment. A conflict whose
   * `(packId, packVersion)` no longer matches the current `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION` is
   * stale — `ConflictsService.list` surfaces that as `ConflictResponseDto.stale` rather than hiding
   * or silently reinterpreting the row.
   */
  @Prop({ type: String, required: true })
  packId: string;

  @Prop({ type: Number, required: true })
  packVersion: number;

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
