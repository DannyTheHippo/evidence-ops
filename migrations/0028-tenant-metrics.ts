import type { Db } from 'mongodb';

const COLLECTION = 'tenant_metrics';
const TENANT_METRIC_UNIQUE_INDEX = 'tenant_metrics_tenantId_metricId_unique';

/**
 * `tenant_metrics` is a new collection (`tenant-metric.schema.ts`), so it gets its index from
 * this first migration rather than growing one at a time the way older collections did. The
 * unique `{ tenantId: 1, metricId: 1 }` index enforces the collection's own invariant — an admin
 * authors at most one label row per measure per tenant, the same reasoning
 * `0027-metric-policies.ts`'s unique `{tenantId, metric}` index documents for `MetricPolicy`.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, metricId: 1 }, { unique: true, name: TENANT_METRIC_UNIQUE_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TENANT_METRIC_UNIQUE_INDEX);
};
