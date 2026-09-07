import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentSchema,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { FactsModule } from '../facts/facts.module';
import { MeasuresModule } from '../measures/measures.module';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/**
 * Imports `FactsModule` for its exported `CanonicalEntityService` and `MeasuresModule` for
 * `MeasuresService` — neither module needs to import this one back, so the graph has no cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: Document.name, schema: DocumentSchema },
    ]),
    FactsModule,
    MeasuresModule,
  ],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
