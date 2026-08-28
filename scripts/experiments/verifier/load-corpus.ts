import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { EvidenceLocator } from '../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  Document,
  DocumentDocument,
} from '../../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import type { CorpusChunk, CorpusDocument } from './types';

export interface LoadedCorpus {
  readonly documents: readonly CorpusDocument[];
  readonly filenameByDocVersionId: Readonly<Record<string, string>>;
}

/** Reading order within a document. No chunk ordinal is stored, so the order comes from the
 *  locator: sheet name first for a spreadsheet, then the numeric position the locator names. */
function chunkSortKey(locator: EvidenceLocator): string {
  const position = (value: number): string => String(value).padStart(6, '0');
  switch (locator.kind) {
    case 'pdf-page':
      return position(locator.page);
    case 'docx-paragraph':
      return position(locator.paragraphIndex);
    case 'text-block':
      return position(locator.blockIndex);
    case 'pptx-slide':
      return position(locator.slide);
    case 'xlsx-region':
      return `${locator.sheetName}|${locator.range}`;
    case 'xlsx-cell':
      return `${locator.sheetName}|${locator.cell}`;
  }
}

/**
 * Reads the corpus already ingested under `tenantId` — documents, their versions, and every chunk
 * — without writing anything. Ingestion belongs to the eval harness; this experiment measures a
 * gate against a corpus that already exists, and re-ingesting would change the chunk ids the
 * verdicts are recorded against.
 *
 * Fails CLOSED when the tenant has no chunks: a run over an empty corpus would draft nothing and
 * report a rate of zero, which reads exactly like a gate that passes everything.
 */
export async function loadCorpus(
  app: INestApplicationContext,
  tenantId: string,
): Promise<LoadedCorpus> {
  const documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
  const documentVersionModel = app.get<Model<DocumentVersionDocument>>(
    getModelToken(DocumentVersion.name),
  );
  const evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(
    getModelToken(EvidenceChunk.name),
  );

  const [versions, documents, chunks] = await Promise.all([
    documentVersionModel.find({ tenantId }).lean(),
    documentModel.find({ tenantId }).lean(),
    evidenceChunkModel
      .find({ tenantId })
      .select({ text: 1, locator: 1, tokenCount: 1, documentVersionId: 1 })
      .lean(),
  ]);

  if (chunks.length === 0) {
    throw new Error(
      `verifier experiment: no evidence_chunks for tenant '${tenantId}' — this harness never ` +
        `ingests. Ingest the corpus first with 'npm run eval -- --ingest --record'.`,
    );
  }

  const titleByDocumentId = new Map(
    documents.map((document) => [document._id.toString(), document.title]),
  );
  const chunksByVersionId = new Map<string, CorpusChunk[]>();
  for (const chunk of chunks) {
    const versionId = chunk.documentVersionId.toString();
    const bucket = chunksByVersionId.get(versionId) ?? [];
    bucket.push({
      chunkId: chunk._id,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      locator: chunk.locator,
    });
    chunksByVersionId.set(versionId, bucket);
  }

  const corpusDocuments: CorpusDocument[] = [];
  const filenameByDocVersionId: Record<string, string> = {};

  for (const version of versions) {
    const documentVersionId = version._id.toString();
    const filename = titleByDocumentId.get(version.documentId.toString());
    if (!filename) {
      // Invariant guard: every version this corpus holds was written alongside its document row.
      // A version with no document means the corpus is corrupt, not that a file is pending.
      throw new Error(
        `verifier experiment: document version '${documentVersionId}' has no document row`,
      );
    }
    filenameByDocVersionId[documentVersionId] = filename;

    const versionChunks = chunksByVersionId.get(documentVersionId) ?? [];
    if (versionChunks.length === 0) {
      continue;
    }
    corpusDocuments.push({
      filename,
      documentVersionId,
      chunks: [...versionChunks].sort((left, right) =>
        chunkSortKey(left.locator).localeCompare(chunkSortKey(right.locator)),
      ),
    });
  }

  return {
    documents: corpusDocuments.sort((left, right) => left.filename.localeCompare(right.filename)),
    filenameByDocVersionId,
  };
}
