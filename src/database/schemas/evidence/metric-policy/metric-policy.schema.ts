import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { METRIC_IDS, type MetricId } from '../../../../features/evidence/facts/metric-ontology';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { DOCUMENT_SOURCE_CLASSES, type DocumentSourceClass } from '../document/document.schema';

export type MetricPolicyDocument = HydratedDocument<WithTimestamps<MetricPolicy>>;

/**
 * A tenant's operator-authored override of `METRIC_ONTOLOGY`'s built-in survivorship
 * configuration for one metric. `MetricPoliciesService.resolveForTenant` folds these rows over
 * the ontology's defaults on read — a row present for `(tenantId, metric)` replaces that metric's
 * `authorityOrder`/`stalenessWindowMs` entirely, never merges field-by-field, so an operator
 * clearing a staleness window stays distinguishable from one who never set one.
 */
@Schema({ timestamps: true, collection: 'metric_policies' })
export class MetricPolicy extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, enum: METRIC_IDS })
  metric: MetricId;

  /** Most-authoritative-first ranking of source classes, same shape and role as
   * `MetricDefinition.authorityOrder` (`metric-ontology.ts`) — absent means this row has no
   * opinion on authority ranking, not that it clears the ontology's own ranking (the whole row
   * still replaces the ontology's policy for this metric; there is simply nothing to rank by). */
  @Prop({ type: [String], enum: DOCUMENT_SOURCE_CLASSES })
  authorityOrder?: DocumentSourceClass[];

  /** Same role as `MetricDefinition.stalenessWindowMs` — absent means this row applies no
   * staleness check for this metric. */
  @Prop({ type: Number })
  stalenessWindowMs?: number;
}

export const MetricPolicySchema = SchemaFactory.createForClass(MetricPolicy);

/**
 * Declared here as well as in `migrations/0027-metric-policies.ts`, with the same keys, options
 * and name — the migration builds the index in a deployed database, this declaration is what
 * `Model.syncIndexes()` builds for a test lane that never runs migrations. Unique: an operator can
 * author at most one policy row per `(tenantId, metric)` — a second row for the same metric would
 * be ambiguous about which one `resolveForTenant` should apply.
 */
MetricPolicySchema.index(
  { tenantId: 1, metric: 1 },
  { unique: true, name: 'metric_policies_tenantId_metric_unique' },
);
