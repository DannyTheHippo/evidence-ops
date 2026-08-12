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
import { CsvParser } from './parsers/csv.parser';
import { DocxParser } from './parsers/docx.parser';
import { PdfParser } from './parsers/pdf.parser';
import type { DocumentParser } from './parsers/parsed-element.type';
import { PptxParser } from './parsers/pptx.parser';
import { TextParser } from './parsers/text.parser';
import { XlsxParser } from './parsers/xlsx.parser';

/**
 * The parser set the registry dispatches on.
 *
 * Exported so a spec can assert the real registration rather than a stub list: every MIME in
 * `SOURCE_KIND_TO_MIME_TYPE` must resolve to a parser here, or an upload the gate accepts reaches
 * a registry that cannot route it.
 */
export const buildDocumentParsers = (): readonly DocumentParser[] => [
  new PdfParser(),
  new DocxParser(),
  new XlsxParser(),
  new PptxParser(),
  new TextParser(),
  /**
   * `CsvParser` is delimiter-parameterised, so CSV and TSV are two instances of one class. The
   * MIME lists here are what `ParserRegistry` dispatches on, and must stay exactly the canonical
   * types `resolveUploadKind` stores on a document.
   */
  new CsvParser(',', ['text/csv']),
  new CsvParser('\t', ['text/tab-separated-values']),
];

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
      useFactory: buildDocumentParsers,
    },
    ParserRegistry,
    IngestionService,
  ],
  exports: [IngestionService, ParserRegistry],
})
export class IngestionModule {}
