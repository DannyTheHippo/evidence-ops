import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, WithTimestamps } from 'mongoose';
import type {
  FactValueType,
  MetricUnitDefinition,
  ToleranceKind,
} from '../../../../features/evidence/facts/metric-ontology';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { DOCUMENT_SOURCE_CLASSES, type DocumentSourceClass } from '../document/document.schema';

export type MetricPackDocument = HydratedDocument<WithTimestamps<MetricPack>>;

export type MetricPackStatus = 'draft' | 'published' | 'active' | 'retired';

export const METRIC_PACK_STATUSES: readonly MetricPackStatus[] = [
  'draft',
  'published',
  'active',
  'retired',
];

/** The code default pack shipped in `features/evidence/facts/packs/cre.pack.ts`. Reserved so that
 * no tenant-authored row in this collection can ever claim it — see `RESERVED_PACK_IDS`. */
export const CRE_PACK_ID = 'cre';

/** Every built-in pack id shipped in code. A tenant-authored row claiming one of these would make
 * `(packId, version)` ambiguous between the code default and a stored row, so the `packId`
 * validator below refuses it at write time regardless of which authoring path attempts it. */
export const RESERVED_PACK_IDS: readonly string[] = [CRE_PACK_ID];

/** One metric's detection configuration within a pack — shape mirrors `MetricDefinition` in
 * `metric-ontology.ts` but `id` is a plain string rather than the closed `MetricId` union, because
 * a pack authored for a domain other than CRE must be free to name metrics `METRIC_IDS` does not
 * enumerate. */
export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly valueType: FactValueType;
  readonly canonicalUnit: string;
  readonly units: readonly MetricUnitDefinition[];
  readonly toleranceKind: ToleranceKind;
  readonly tolerance: number;
  readonly authorityOrder?: readonly DocumentSourceClass[];
  readonly stalenessWindowMs?: number;
}

/** The plain, read-only shape `MetricPacksService.resolveActive` returns regardless of whether the
 * resolved pack is a tenant-authored `MetricPack` document or the code default `CRE_PACK_V1` — the
 * two are structurally interchangeable to a caller that only reads a pack's detection config, never
 * its lifecycle fields (`status`, audit stamps). */
export interface MetricPackData {
  readonly packId: string;
  readonly version: number;
  readonly label: string;
  readonly metrics: readonly MetricDefinition[];
}

// Exported so `CreateMetricPackVersionRequestDto` (`create-metric-pack-version.request.dto.ts`)
// validates `valueType`/`toleranceKind` against these same lists rather than a second copy.
export const FACT_VALUE_TYPES: readonly FactValueType[] = [
  'currency',
  'percentage',
  'area',
  'duration',
];
export const TOLERANCE_KINDS: readonly ToleranceKind[] = ['absolute', 'relative'];

// Value object, not an entity: a unit has no identity of its own and is only ever read as part of
// its owning metric — same reasoning `FactKeySchema` (`extracted-fact.schema.ts`) documents for
// `_id: false`.
const MetricUnitDefinitionSchema = new MongooseSchema<MetricUnitDefinition>(
  {
    id: { type: String, required: true, trim: true },
    toCanonicalFactor: { type: Number, required: true },
  },
  { _id: false },
);

const MetricDefinitionSchema = new MongooseSchema<MetricDefinition>(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    aliases: { type: [String], required: true },
    valueType: { type: String, required: true, enum: FACT_VALUE_TYPES },
    canonicalUnit: { type: String, required: true, trim: true },
    units: { type: [MetricUnitDefinitionSchema], required: true },
    toleranceKind: { type: String, required: true, enum: TOLERANCE_KINDS },
    tolerance: { type: Number, required: true },
    authorityOrder: { type: [String], enum: DOCUMENT_SOURCE_CLASSES },
    stalenessWindowMs: { type: Number },
  },
  { _id: false },
);

/**
 * A versioned, tenant-authorable pack of metric-detection configuration — the data form of what
 * `METRIC_ONTOLOGY` used to hard-code. `MetricPacksService.resolveActive` folds a tenant's
 * `status: 'active'` row over the code default `CRE_PACK_V1`, so a tenant with no authored pack
 * still resolves to exactly today's built-in ontology.
 */
@Schema({ timestamps: true, collection: 'metric_packs' })
export class MetricPack extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: (value: string): boolean => !RESERVED_PACK_IDS.includes(value),
      message: (props: { value: string }): string =>
        `'${props.value}' is a reserved pack id and cannot be used by a tenant-authored pack`,
    },
  })
  packId: string;

  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (value: number): boolean => Number.isInteger(value),
      message: 'version must be an integer',
    },
  })
  version: number;

  @Prop({ type: String, required: true, enum: METRIC_PACK_STATUSES })
  status: MetricPackStatus;

  @Prop({ type: String, required: true, trim: true })
  label: string;

  @Prop({ type: [MetricDefinitionSchema], required: true })
  metrics: MetricDefinition[];

  /**
   * The pack this version was drafted from — `resolveActive(tenantId)` at draft-creation time
   * when the operator names no `parentVersion`, or the named version otherwise. Stored rather than
   * re-resolved at publish time: the tenant's active pack can change while a draft is being
   * authored, and `MetricPacksService.publish` must diff against the parent the operator actually
   * chose, not whatever happens to be active when they click publish. Absent only for a row
   * predating this field.
   */
  @Prop({ type: String })
  parentPackId?: string;

  @Prop({ type: Number })
  parentVersion?: number;
}

export const MetricPackSchema = SchemaFactory.createForClass(MetricPack);

/**
 * Declared here as well as in a migration owned by another lane, with the same keys, options and
 * name — the migration builds the index in a deployed database, this declaration is what
 * `Model.syncIndexes()` builds for a test lane that never runs migrations. Unique: a tenant can
 * author at most one row per `(packId, version)` — a second row for the same stamped version would
 * be ambiguous about which one a reference to that version means.
 */
MetricPackSchema.index(
  { tenantId: 1, packId: 1, version: 1 },
  { unique: true, name: 'metric_packs_tenantId_packId_version_unique' },
);

/**
 * The active-pack pointer. Partial and unique on `tenantId` alone, filtered to `status: 'active'`:
 * MongoDB enforces "at most one active pack per tenant" as a database invariant rather than a
 * service-level convention, and there is no separate pointer field on `Tenant` that could drift out
 * of sync with the row it names — the active row names itself.
 */
MetricPackSchema.index(
  { tenantId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'metric_packs_tenantId_active_unique',
  },
);
