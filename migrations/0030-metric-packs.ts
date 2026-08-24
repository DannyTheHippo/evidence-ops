import type { Db } from 'mongodb';

const METRIC_PACKS_COLLECTION = 'metric_packs';
const EXTRACTED_FACTS_COLLECTION = 'extracted_facts';
const CONFLICTS_COLLECTION = 'conflicts';

const METRIC_PACKS_TENANT_PACK_VERSION_INDEX = 'metric_packs_tenantId_packId_version_unique';
const METRIC_PACKS_TENANT_ACTIVE_INDEX = 'metric_packs_tenantId_active_unique';

const BACKFILL_PACK_ID = 'cre';
const BACKFILL_PACK_VERSION = 1;

/**
 * `metric-ontology.ts`'s `METRIC_ONTOLOGY`, grouped by `canonicalUnit`, as of the moment this
 * migration was written. Inlined rather than imported: a migration is an immutable applied
 * snapshot (`mongoose.md` — "FORBIDDEN to edit a migration that has already been applied"), the
 * same reasoning `0013-fact-group-key-normalized.ts` documents for inlining `groupKey` instead of
 * importing it. If the ontology's canonical units ever change, a later migration re-backfills —
 * this one stays a frozen record of what `magnitudeUnit` meant for each metric the day it ran.
 */
const CANONICAL_UNITS_BY_METRIC: Readonly<Record<string, readonly string[]>> = {
  ratio: ['cap_rate', 'tenant_occupancy_share'],
  usd: ['sale_price', 'net_operating_income'],
  usd_per_sf: ['price_per_sf'],
  sf: ['building_area_sf'],
  usd_per_sf_per_year: ['base_rent_psf'],
  years: ['lease_term_years'],
};

/**
 * `metric_packs` is a new collection (`metric-pack.schema.ts`, owned by a parallel change), so it
 * gets its indexes here rather than growing one at a time. Names, keys and options are
 * byte-identical to that schema's own `MetricPackSchema.index()` declarations — the same document
 * both sides carry says why: the migration builds these in a deployed database, the schema
 * declaration is what `Model.syncIndexes()` builds for a test lane that never runs migrations, and
 * MongoDB refuses a second index on an already-carried key pattern under a different name.
 */
async function createMetricPacksIndexes(db: Db): Promise<void> {
  const collection = db.collection(METRIC_PACKS_COLLECTION);
  await collection.createIndex(
    { tenantId: 1, packId: 1, version: 1 },
    { unique: true, name: METRIC_PACKS_TENANT_PACK_VERSION_INDEX },
  );
  await collection.createIndex(
    { tenantId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: 'active' },
      name: METRIC_PACKS_TENANT_ACTIVE_INDEX,
    },
  );
}

/**
 * Stamps every `extracted_facts`/`conflicts` row written before packs existed with the pack that
 * provably produced it. `'cre'` v1 is byte-identical to `METRIC_ONTOLOGY` as it stands in this
 * codebase — the only ontology this code has ever had — so every existing row is truthfully a
 * `'cre'` v1 row, not a fabricated default; see `ExtractedFact.packId`/`Conflict.packId`'s own doc
 * comments for why the field is required rather than left absent like an ordinary backfill gap.
 */
async function backfillPackStamp(db: Db, collectionName: string): Promise<void> {
  await db
    .collection(collectionName)
    .updateMany(
      { packId: { $exists: false } },
      { $set: { packId: BACKFILL_PACK_ID, packVersion: BACKFILL_PACK_VERSION } },
    );
}

/**
 * `Conflict.magnitude` is `max - min` in whatever `canonicalUnit` was in force when detection ran
 * — a stored `0.0085` is 85 basis points only because `cap_rate`'s canonical unit is a ratio, and
 * nothing on the row records that. One `updateMany` per distinct canonical unit, keyed on
 * `factKey.metric: { $in: [...] }`, so a currency-metric conflict backfills to `'usd'` and a
 * ratio-metric conflict backfills to `'ratio'` rather than every row taking the same blanket
 * value — a blanket value would be a plausible-looking lie on every non-ratio conflict.
 */
async function backfillMagnitudeUnit(db: Db): Promise<void> {
  const collection = db.collection(CONFLICTS_COLLECTION);
  for (const [canonicalUnit, metrics] of Object.entries(CANONICAL_UNITS_BY_METRIC)) {
    await collection.updateMany(
      { magnitudeUnit: { $exists: false }, 'factKey.metric': { $in: metrics } },
      { $set: { magnitudeUnit: canonicalUnit } },
    );
  }
}

export const up = async (db: Db): Promise<void> => {
  await createMetricPacksIndexes(db);
  await backfillPackStamp(db, EXTRACTED_FACTS_COLLECTION);
  await backfillPackStamp(db, CONFLICTS_COLLECTION);
  await backfillMagnitudeUnit(db);
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(METRIC_PACKS_COLLECTION).dropIndex(METRIC_PACKS_TENANT_PACK_VERSION_INDEX);
  await db.collection(METRIC_PACKS_COLLECTION).dropIndex(METRIC_PACKS_TENANT_ACTIVE_INDEX);

  await db
    .collection(EXTRACTED_FACTS_COLLECTION)
    .updateMany({}, { $unset: { packId: '', packVersion: '' } });
  await db
    .collection(CONFLICTS_COLLECTION)
    .updateMany({}, { $unset: { packId: '', packVersion: '', magnitudeUnit: '' } });
};
