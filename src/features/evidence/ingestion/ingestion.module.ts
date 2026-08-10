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
import { ProvidersModule } from '../../../providers/providers.module';
import { IngestionService } from './ingestion.service';
import { DOCUMENT_PARSERS, ParserRegistry } from './parser.registry';
import { DocxParser } from './parsers/docx.parser';
import { PdfParser } from './parsers/pdf.parser';
import type { DocumentParser } from './parsers/parsed-element.type';
import { XlsxParser } from './parsers/xlsx.parser';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
    ]),
    ProvidersModule,
  ],
  providers: [
    // The parsers carry no DI dependencies of their own, so this factory — rather than
    // registering each class as a provider — is what makes them a single injectable list
    // `ParserRegistry` can iterate without depending on Nest's class-provider resolution.
    {
      provide: DOCUMENT_PARSERS,
      useFactory: (): readonly DocumentParser[] => [
        new PdfParser(),
        new DocxParser(),
        new XlsxParser(),
      ],
    },
    ParserRegistry,
    IngestionService,
  ],
  exports: [IngestionService, ParserRegistry],
})
export class IngestionModule {}
