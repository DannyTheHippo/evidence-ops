import type { Db } from 'mongodb';

const COLLECTION = 'metric_policies';
const TENANT_METRIC_UNIQUE_INDEX = 'metric_policies_tenantId_metric_unique';

/**
 * `metric_policies` is a new collection (`metric-policy.schema.ts`), so it gets its index from
 * this first migration rather than growing one at a time the way older collections did. The
 * unique `{ tenantId: 1, metric: 1 }` index enforces the collection's own invariant — an operator
 * authors at most one policy row per metric per tenant, the same reasoning
 * `0018-canonical-entities.ts`'s unique `{tenantId, canonicalNameNormalized}` index documents for
 * `CanonicalEntity` — and is what `MetricPoliciesService.resolveForTenant`'s whole-row-override
 * fold relies on: at most one override row can exist per `(tenantId, metric)`.
 */
export const up = async (db: Db): Promise<void> => {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, metric: 1 }, { unique: true, name: TENANT_METRIC_UNIQUE_INDEX });
};

export const down = async (db: Db): Promise<void> => {
  await db.collection(COLLECTION).dropIndex(TENANT_METRIC_UNIQUE_INDEX);
};
