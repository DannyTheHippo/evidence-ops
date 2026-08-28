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
import { ProvidersModule } from '../../../providers/providers.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { CanonicalEntitiesController } from './canonical-entities.controller';
import { CanonicalEntityService } from './canonical-entity.service';
import { FactsService } from './facts.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CanonicalEntity.name, schema: CanonicalEntitySchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
    ]),
    ProvidersModule,
    // Only for its exported `ParserRegistry` — fact extraction re-parses a version's bytes itself
    // rather than depending on `IngestionService`, since it needs the raw `ParsedElement`s (for
    // deterministic xlsx facts, and for narrowing a prose fact's locator past its chunk's anchor).
    IngestionModule,
  ],
  controllers: [CanonicalEntitiesController, MetricsController],
  // Exported as well as registered: `FactsService` depends on `CanonicalEntityService` to
  // canonicalize an extracted fact's entity, but the registry is also reachable via DI on its own,
  // the same way `FactsService` is.
  providers: [CanonicalEntityService, FactsService, MetricsService],
  exports: [CanonicalEntityService, FactsService],
})
export class FactsModule {}
