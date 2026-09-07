import type { Model } from 'mongoose';
import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';
import type {
  MeasureDocument,
  MeasureUnit,
} from '../../../database/schemas/evidence/measure/measure.schema';
import { METRIC_ONTOLOGY, type FactValueType, type ToleranceKind } from '../facts/metric-ontology';

/**
 * A row `buildSeedMeasureRows` mints, ready for `Model.insertMany`. Field-for-field the same
 * shape `MeasureUnitSchema`/`MeasuresService` produce for any other measure, pinned to the
 * `'confirmed'`/`'seed'`/version-1 values only a seed row ever carries.
 */
export interface SeedMeasureRow {
  tenantId: string;
  slug: string;
  label: string;
  aliases: string[];
  valueType: FactValueType;
  canonicalUnit: string;
  units: MeasureUnit[];
  toleranceKind: ToleranceKind;
  tolerance: number;
  authorityOrder?: DocumentSourceClass[];
  stalenessWindowMs?: number;
  status: 'confirmed';
  origin: 'seed';
  proposedFrom: [];
  version: 1;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `METRIC_ONTOLOGY` projected field-for-field into `measures` rows for one tenant, `confirmed`
 * from birth at `version: 1` — the replay-cache invariant `orderForExtraction` and this file's
 * own spec pin depend on this projection staying byte-identical to its ontology source, never a
 * paraphrase of it. `authorityOrder`/`stalenessWindowMs` are included only when the source metric
 * configures one, matching `Measure.authorityOrder`'s `default: undefined` — an omitted key here
 * reads back as an omitted key there, never as an empty array.
 */
export function buildSeedMeasureRows(tenantId: string, now: Date = new Date()): SeedMeasureRow[] {
  return METRIC_ONTOLOGY.map<SeedMeasureRow>((metric) => ({
    tenantId,
    slug: metric.id,
    label: metric.label,
    aliases: [...metric.aliases],
    valueType: metric.valueType,
    canonicalUnit: metric.canonicalUnit,
    units: metric.units.map((unit) => ({ ...unit })),
    toleranceKind: metric.toleranceKind,
    tolerance: metric.tolerance,
    ...(metric.authorityOrder ? { authorityOrder: [...metric.authorityOrder] } : {}),
    ...(metric.stalenessWindowMs !== undefined
      ? { stalenessWindowMs: metric.stalenessWindowMs }
      : {}),
    status: 'confirmed',
    origin: 'seed',
    proposedFrom: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
}

/** Seeds every `METRIC_ONTOLOGY` measure for one tenant. Called once from `AuthService.register`
 * on tenant birth, and once per tenant from `migrations/0001-baseline.ts`'s upsert loop, which
 * tolerates re-running this against an already-seeded tenant by keying on `{tenantId, slug}`
 * itself rather than relying on this function to be idempotent. */
export async function seedMeasures(model: Model<MeasureDocument>, tenantId: string): Promise<void> {
  await model.insertMany(buildSeedMeasureRows(tenantId));
}
