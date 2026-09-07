import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { EvidenceLocator } from '../evidence-chunk/evidence-locator.type';

export type ExtractionMethod = 'llm' | 'regex' | 'manual';

export const EXTRACTION_METHODS: readonly ExtractionMethod[] = ['llm', 'regex', 'manual'];

/** `'rejected'` is deliberately not a member: a fact never carries a measure status a human has
 * rejected — rejection happens on the `Measure`, and a rejected measure proposes no more facts. */
export type FactMeasureStatus = 'proposed' | 'confirmed';

export const FACT_MEASURE_STATUSES: readonly FactMeasureStatus[] = ['proposed', 'confirmed'];

/** Identifies what a fact is about, independent of which document reported it — the key two or
 * more `ExtractedFact`s must share for `Conflict` detection to compare them. */
export interface FactKey {
  entity: string;
  metric: string;
  period: string;
}

export interface FactValue {
  amount: number;
  unit: string;
}

export type ExtractedFactDocument = HydratedDocument<WithTimestamps<ExtractedFact>>;

// Both are value objects, not entities: they have no identity of their own and are only ever
// read as a whole. `_id: false` keeps Mongoose from minting a meaningless ObjectId inside every
// one — which would also make two structurally identical fact keys compare unequal, and fact-key
// equality is exactly what conflict detection groups on.
const FactKeySchema = new MongooseSchema<FactKey>(
  {
    entity: { type: String, required: true, trim: true },
    metric: { type: String, required: true, trim: true },
    period: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const FactValueSchema = new MongooseSchema<FactValue>(
  {
    amount: { type: Number, required: true },
    unit: { type: String, required: true, trim: true },
  },
  { _id: false },
);

@Schema({ timestamps: true, collection: 'extracted_facts' })
export class ExtractedFact extends AuditableDocument {
  @Prop({ type: FactKeySchema, required: true })
  factKey: FactKey;

  @Prop({ type: FactValueSchema, required: true })
  value: FactValue;

  // `ConflictsService`/`FactsService`'s `groupKey(factKey)` (`detect-conflicts.ts`) computed at
  // write time, not read on demand: grouping is case-insensitive on `entity`, and no MongoDB
  // collation index can serve a case-insensitive compound index the way a plain field can — see
  // `migrations/0001-baseline.ts`'s own doc comment for the index this field
  // exists to support (incremental conflict scans scoped to `{tenantId, groupKeyNormalized}`).
  @Prop({ type: String, required: true })
  groupKeyNormalized: string;

  @Prop({ type: String, required: true })
  rawText: string;

  @Prop({ type: Number, required: true, min: 0, max: 1 })
  confidence: number;

  @Prop({ type: String, required: true, enum: EXTRACTION_METHODS })
  extractionMethod: ExtractionMethod;

  /**
   * The seed metric ontology (`metric-ontology.ts`'s `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION`) in
   * force when this fact was extracted — the ontology-wide provenance stamp, kept beside the
   * per-measure stamp (`measureId`/`measureVersion`/`measureStatus` below) rather than replaced
   * by it. Required, not optional: a fact that cannot say which ontology and tolerance produced
   * it would resolve against whatever the ontology happens to be at read time, quietly and
   * possibly wrongly — the same reasoning `EvidenceLocator.extractorVersion` documents for a
   * coordinate's extractor.
   */
  @Prop({ type: String, required: true })
  packId: string;

  @Prop({ type: Number, required: true })
  packVersion: number;

  /**
   * The `Measure` (`measure.schema.ts`) and its version in force when this fact was extracted —
   * a second provenance stamp, scoped to the one measure definition that produced this value
   * rather than the whole ontology. Facts keep the version they were extracted under; consumers
   * evaluate the value against the measure's current definition, not this stamp.
   */
  @Prop({ type: Types.ObjectId, ref: 'Measure', required: true })
  measureId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  measureVersion: number;

  /**
   * The exclusion flag every downstream consumer filters on. `'proposed'` means the fact was
   * extracted under a measure no admin has confirmed yet: the fact is stored but invisible to
   * `scanForConflicts`, `findCellFacts`, `findFactsForChunks`, and `LedgerService`'s
   * `listCells`/`resolveValue`, until confirming the measure flips this to `'confirmed'` and
   * rescans the fact's group.
   */
  @Prop({ type: String, required: true, enum: FACT_MEASURE_STATUSES })
  measureStatus: FactMeasureStatus;

  /**
   * Inclusive calendar bounds from `parsePeriodKey(factKey.period).range` at extraction time.
   * Both absent for a `fiscal-year`, `unstated`, or unparseable `factKey.period` — the same cases
   * `parsePeriodKey` itself returns no range for.
   */
  @Prop({ type: Date })
  periodStart?: Date;

  @Prop({ type: Date })
  periodEnd?: Date;

  // `EvidenceChunk._id` is a content-addressed string (`computeChunkId`), not an ObjectId — see
  // that schema's own doc comment.
  @Prop({ type: String, ref: 'EvidenceChunk', required: true })
  chunkId: string;

  // Scopes `FactsService.extractFacts`'s idempotency check and partial-insert rollback to exactly
  // this version's facts — the same role `EvidenceChunk.documentVersionId` plays for
  // `IngestionService.ingestVersion`'s analogous check.
  @Prop({ type: Types.ObjectId, ref: 'DocumentVersion', required: true })
  documentVersionId: Types.ObjectId;

  // Own copy of the locator, not just the chunk's: the fact may pin a narrower position than the
  // chunk it was extracted from (e.g. one `xlsx-cell` inside a chunk spanning an `xlsx-region`).
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  locator: EvidenceLocator;

  @Prop({ type: String, required: true })
  tenantId: string;

  /**
   * When the value itself was observed/recorded, distinct from `factKey.period` — the period is
   * what the value *describes* (e.g. "March"), `observedAt` is when someone recorded that value
   * (e.g. a March figure entered in June is fresher, for staleness purposes, than one entered in
   * April even though both describe the same period). Left absent, never defaulted to `createdAt`
   * or the current time: a fabricated observation date would let a later recency rule fire on
   * evidence that never actually carried one.
   */
  @Prop({ type: Date })
  observedAt?: Date;

  /**
   * Whether `factKey.entity` matched an entry in the tenant's `CanonicalEntity` registry
   * (`CanonicalEntityService.resolveMany`) at extraction time. `false` means `factKey.entity` is
   * the raw name exactly as extracted, unresolved rather than dropped or guessed at, so a human
   * can find the registry's gaps by querying for `entityMatched: false`. Optional, not backfilled,
   * because a fact extracted before this field existed carries no opinion either way.
   */
  @Prop({ type: Boolean })
  entityMatched?: boolean;
}

export const ExtractedFactSchema = SchemaFactory.createForClass(ExtractedFact);
