import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type TenantMetricDocument = HydratedDocument<WithTimestamps<TenantMetric>>;

/**
 * A tenant-authored label for a measure. `metricId` is not constrained to `METRIC_IDS` — a row
 * whose id already names a code-ontology metric renames that metric's display label; a row whose
 * id names anything else adds a wholly new catalog entry. Neither case carries `tolerance` or
 * `unit`: this schema has no properties for them, and no request path can populate what the
 * schema does not accept. Fact extraction and conflict detection read `METRIC_ONTOLOGY` directly
 * and never this collection, so a row here changes only what a measure is called, never what
 * counts as a disagreement about it.
 */
@Schema({ timestamps: true, collection: 'tenant_metrics' })
export class TenantMetric extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true })
  metricId: string;

  @Prop({ type: String, required: true })
  label: string;
}

export const TenantMetricSchema = SchemaFactory.createForClass(TenantMetric);

/**
 * Declared here as well as in `migrations/0028-tenant-metrics.ts`, with the same keys, options
 * and name — the migration builds the index in a deployed database, this declaration is what
 * `Model.syncIndexes()` builds for a test lane that never runs migrations. Unique: an admin can
 * author at most one row per `(tenantId, metricId)` — a second row for the same id would be
 * ambiguous about which label applies.
 */
TenantMetricSchema.index(
  { tenantId: 1, metricId: 1 },
  { unique: true, name: 'tenant_metrics_tenantId_metricId_unique' },
);
