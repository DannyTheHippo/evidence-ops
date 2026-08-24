import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { EvidenceLocator } from '../evidence-chunk/evidence-locator.type';

export type ExtractionMethod = 'llm' | 'regex' | 'manual';

export const EXTRACTION_METHODS: readonly ExtractionMethod[] = ['llm', 'regex', 'manual'];

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
  // `migrations/0013-fact-group-key-normalized.ts`'s own doc comment for the index this field
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
   * The metric pack (`metric-ontology.ts`'s `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION` until a
   * resolved `MetricPack` replaces them) in force when this fact was extracted. Required, not
   * optional: a fact that cannot say which ontology and tolerance produced it resolves against
   * *some* pack once a pack becomes editable per engagement, quietly and possibly wrongly — the
   * same reasoning `EvidenceLocator.extractorVersion` documents for a coordinate's extractor.
   */
  @Prop({ type: String, required: true })
  packId: string;

  @Prop({ type: Number, required: true })
  packVersion: number;

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
