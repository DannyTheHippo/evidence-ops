import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import {
  FACT_VALUE_TYPES,
  TOLERANCE_KINDS,
  type FactValueType,
  type ToleranceKind,
} from '../../../../features/evidence/facts/metric-ontology';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { DOCUMENT_SOURCE_CLASSES, type DocumentSourceClass } from '../document/document.schema';
import { EvidenceLocator } from '../evidence-chunk/evidence-locator.type';

export type MeasureStatus = 'proposed' | 'confirmed' | 'rejected';

export const MEASURE_STATUSES: readonly MeasureStatus[] = ['proposed', 'confirmed', 'rejected'];

export type MeasureOrigin = 'seed' | 'header' | 'manual';

export const MEASURE_ORIGINS: readonly MeasureOrigin[] = ['seed', 'header', 'manual'];

/** `MeasuresService.proposeMany` stops recording new header evidence past this count — a
 * proposal a human has ignored fifty times over needs a decision, not fifty-first evidence. */
export const MAX_PROPOSED_FROM_PER_MEASURE = 50;

export const MAX_HEADER_TEXT_CHARS = 200;

export const MAX_MEASURE_SLUG_CHARS = 64;

export type MeasureDocument = HydratedDocument<WithTimestamps<Measure>>;

/** A value object, not an entity: `_id: false` keeps Mongoose from minting a meaningless ObjectId
 * inside every unit. */
export interface MeasureUnit {
  id: string;
  toCanonicalFactor: number;
}

const MeasureUnitSchema = new MongooseSchema<MeasureUnit>(
  {
    id: { type: String, required: true, trim: true },
    toCanonicalFactor: { type: Number, required: true },
  },
  { _id: false },
);

/** One document's header/phrase evidence for a `'header'`-origin proposal, recorded by
 * `MeasuresService.proposeMany`. A value object, not an entity — see `MeasureUnit` above. */
export interface MeasureProposalEvidence {
  documentVersionId: Types.ObjectId;
  locator: EvidenceLocator;
  headerText: string;
}

const MeasureProposalEvidenceSchema = new MongooseSchema<MeasureProposalEvidence>(
  {
    documentVersionId: { type: Types.ObjectId, ref: 'DocumentVersion', required: true },
    locator: { type: MongooseSchema.Types.Mixed, required: true },
    headerText: { type: String, required: true, trim: true, maxlength: MAX_HEADER_TEXT_CHARS },
  },
  { _id: false },
);

/** The outcome of the synchronous rescan `MeasuresService` runs when a measure is confirmed,
 * edited, or re-confirmed. Fails OPEN: a `'failed'` row means the confirm/edit itself already
 * persisted and the rescan's own failure is recorded here rather than rolled back — see
 * `MeasuresService.confirm`'s doc comment for the full failure-direction statement. */
export interface MeasureRescan {
  at: Date;
  status: 'completed' | 'failed';
  durationMs: number;
  conflictsCreated?: number;
  skippedFactCount?: number;
  error?: string;
}

const MeasureRescanSchema = new MongooseSchema<MeasureRescan>(
  {
    at: { type: Date, required: true },
    status: { type: String, required: true, enum: ['completed', 'failed'] },
    durationMs: { type: Number, required: true, min: 0 },
    conflictsCreated: { type: Number },
    skippedFactCount: { type: Number },
    error: { type: String },
  },
  { _id: false },
);

/**
 * A tenant's adjudicable definition of one measure — the confirmed/proposed/rejected registry
 * that `METRIC_ONTOLOGY` seeds (`measure-seed.ts`) and every fact extractor, conflict scan and
 * ledger cell resolves against. `slug` is the join key `ExtractedFact.factKey.metric` carries;
 * consumers look a measure up with the existing generic `findMetricById(definitions, slug)`
 * rather than by this document's `_id` — `_id` (as `measureId`) is provenance on a fact, not the
 * key facts group by.
 */
@Schema({ timestamps: true, collection: 'measures' })
export class Measure extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, trim: true, maxlength: MAX_MEASURE_SLUG_CHARS })
  slug: string;

  @Prop({ type: String, required: true, trim: true, maxlength: MAX_HEADER_TEXT_CHARS })
  label: string;

  /**
   * Header and phrase forms matched case-insensitively when an extractor resolves a column to a
   * measure. `default: undefined` keeps `required` meaningful: Mongoose otherwise substitutes `[]`
   * for a missing array, which satisfies `required` and lets an alias-less row persist.
   */
  @Prop({ type: [String], required: true, default: undefined })
  aliases: string[];

  @Prop({ type: String, required: true, enum: FACT_VALUE_TYPES })
  valueType: FactValueType;

  @Prop({ type: String, required: true, trim: true })
  canonicalUnit: string;

  @Prop({
    type: [MeasureUnitSchema],
    required: true,
    validate: {
      validator: (units: MeasureUnit[]) => Array.isArray(units) && units.length >= 1,
      message: 'A measure requires at least one unit',
    },
  })
  units: MeasureUnit[];

  @Prop({ type: String, required: true, enum: TOLERANCE_KINDS })
  toleranceKind: ToleranceKind;

  @Prop({ type: Number, required: true, min: 0 })
  tolerance: number;

  /**
   * Optional and left `undefined` rather than Mongoose's usual `[]` default for an array prop
   * (`default: undefined`, set explicitly): a seed row copied verbatim from `METRIC_ONTOLOGY`,
   * where this field is itself optional and absent on most metrics, must read back with the key
   * absent too — an auto-defaulted `[]` would make that row diverge from its ontology source and
   * mean something different besides ("no authority configured" versus "authority order
   * deliberately empty").
   */
  @Prop({ type: [{ type: String, enum: DOCUMENT_SOURCE_CLASSES }], default: undefined })
  authorityOrder?: DocumentSourceClass[];

  @Prop({ type: Number, min: 0 })
  stalenessWindowMs?: number;

  @Prop({ type: String, required: true, enum: MEASURE_STATUSES, default: 'proposed' })
  status: MeasureStatus;

  @Prop({ type: String, required: true, enum: MEASURE_ORIGINS })
  origin: MeasureOrigin;

  @Prop({
    type: [MeasureProposalEvidenceSchema],
    required: true,
    default: [],
    validate: {
      validator: (evidence: MeasureProposalEvidence[]) =>
        Array.isArray(evidence) && evidence.length <= MAX_PROPOSED_FROM_PER_MEASURE,
      message: `A measure cannot carry more than ${MAX_PROPOSED_FROM_PER_MEASURE} proposal evidence entries`,
    },
  })
  proposedFrom: MeasureProposalEvidence[];

  /**
   * Bumped on every `confirm`/`update` (with or without edits) — never on the fact side, which
   * keeps whichever version it was extracted under as provenance. Seed rows are the only rows
   * that ever read `1` while `confirmed`, because `confirm` always increments past it.
   */
  @Prop({ type: Number, required: true, min: 1 })
  version: number;

  @Prop({ type: String })
  confirmedBy?: string;

  @Prop({ type: Date })
  confirmedAt?: Date;

  @Prop({ type: String })
  rejectedBy?: string;

  @Prop({ type: Date })
  rejectedAt?: Date;

  @Prop({ type: String })
  rejectedReason?: string;

  @Prop({ type: MeasureRescanSchema })
  lastRescan?: MeasureRescan;
}

export const MeasureSchema = SchemaFactory.createForClass(Measure);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same keys, options and
 * names — see `canonical-entity.schema.ts`'s identical pair for why: the migration builds them in
 * a deployed database, these declarations are what `Model.syncIndexes()` builds, which is how a
 * test lane that never runs migrations still enforces the uniqueness `MeasuresService` relies on.
 */
MeasureSchema.index(
  { tenantId: 1, slug: 1 },
  { unique: true, name: 'measures_tenantId_slug_unique' },
);
MeasureSchema.index(
  { tenantId: 1, status: 1, createdAt: -1 },
  { name: 'measures_tenantId_status_createdAt' },
);
