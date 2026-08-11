import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
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

  @Prop({ type: String, required: true })
  rawText: string;

  @Prop({ type: Number, required: true, min: 0, max: 1 })
  confidence: number;

  @Prop({ type: String, required: true, enum: EXTRACTION_METHODS })
  extractionMethod: ExtractionMethod;

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

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const ExtractedFactSchema = SchemaFactory.createForClass(ExtractedFact);
