import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CanonicalEntity,
  CanonicalEntitySchema,
} from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  MetricPolicy,
  MetricPolicySchema,
} from '../../../database/schemas/evidence/metric-policy/metric-policy.schema';
import {
  TenantMetric,
  TenantMetricSchema,
} from '../../../database/schemas/evidence/tenant-metric/tenant-metric.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { CanonicalEntityService } from './canonical-entity.service';
import { FactsService } from './facts.service';
import { MetricPoliciesController } from './metric-policies.controller';
import { MetricPoliciesService } from './metric-policies.service';
import { TenantMetricsController } from './tenant-metrics.controller';
import { TenantMetricsService } from './tenant-metrics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CanonicalEntity.name, schema: CanonicalEntitySchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: MetricPolicy.name, schema: MetricPolicySchema },
      { name: TenantMetric.name, schema: TenantMetricSchema },
    ]),
    ProvidersModule,
    // Only for its exported `ParserRegistry` — fact extraction re-parses a version's bytes itself
    // rather than depending on `IngestionService`, since it needs the raw `ParsedElement`s (for
    // deterministic xlsx facts, and for narrowing a prose fact's locator past its chunk's anchor).
    IngestionModule,
  ],
  controllers: [MetricPoliciesController, TenantMetricsController],
  // Exported as well as registered: `FactsService` depends on `CanonicalEntityService` to
  // canonicalize an extracted fact's entity, but the registry is also reachable via DI on its own,
  // the same way `FactsService` is. `MetricPoliciesService`/`TenantMetricsService` are exported for
  // the same reason — reachable on their own by a future caller without depending on `FactsService`.
  providers: [CanonicalEntityService, FactsService, MetricPoliciesService, TenantMetricsService],
  exports: [CanonicalEntityService, FactsService, MetricPoliciesService, TenantMetricsService],
})
export class FactsModule {}
