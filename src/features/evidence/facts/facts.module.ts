import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
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
import { FactsService } from './facts.service';

@Module({
  imports: [
    MongooseModule.forFeature([
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
  providers: [FactsService],
  exports: [FactsService],
})
export class FactsModule {}
