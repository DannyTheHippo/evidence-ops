import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../src/database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  DocumentDocument,
} from '../src/database/schemas/evidence/document/document.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { IngestedFixture, IngestFixturesResult } from './ingest-fixtures';

/**
 * Reuse-path counterpart to `ingestFixtures`: rebuilds the same `IngestFixturesResult` shape from
 * rows already in Mongo instead of re-ingesting, so `run.ts`'s downstream locator-overlap code
 * stays untouched by which path produced it.
 *
 * Joins `document_versions` to `documents` by `documentId` rather than reading
 * `Document.currentVersionId` — a chunk can reference *any* version a document has ever had (the
 * eval fixtures happen to have exactly one, but nothing here should assume that), and
 * `currentVersionId` alone would silently drop a non-current version's filename from the map,
 * sending its chunks through `run.ts`'s `?? ''` fallback with no error anywhere.
 */
export async function loadExistingCorpus(
  app: INestApplicationContext,
  tenantId: string,
): Promise<IngestFixturesResult> {
  const documentModel = app.get<Model<DocumentDocument>>(getModelToken(Document.name));
  const documentVersionModel = app.get<Model<DocumentVersionDocument>>(
    getModelToken(DocumentVersion.name),
  );
  const evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(
    getModelToken(EvidenceChunk.name),
  );
  const extractedFactModel = app.get<Model<ExtractedFactDocument>>(
    getModelToken(ExtractedFact.name),
  );

  const [versions, documents] = await Promise.all([
    documentVersionModel.find({ tenantId }).lean(),
    documentModel.find({ tenantId }).lean(),
  ]);
  const documentById = new Map(documents.map((document) => [document._id.toString(), document]));

  const fixtures: IngestedFixture[] = [];
  const filenameByDocVersionId = new Map<string, string>();

  for (const version of versions) {
    const documentIdStr = version.documentId.toString();
    const document = documentById.get(documentIdStr);
    if (!document) {
      // Invariant guard, not a normal input-validation branch: every `DocumentVersion` this
      // harness ever writes has a parent `Document` row created in the same `ingestFixtures` call
      // — a version with no matching document means the corpus is corrupt (a partial delete, a
      // hand-edited row), not a normal "document not yet uploaded" state a reuse run should
      // quietly skip past.
      throw new Error(
        `eval: corrupt corpus for tenant '${tenantId}' — document version ` +
          `'${version._id.toString()}' has no matching document '${documentIdStr}'`,
      );
    }

    const documentVersionId = version._id.toString();
    const [chunksCreated, factsCreated] = await Promise.all([
      evidenceChunkModel.countDocuments({ documentVersionId: version._id, tenantId }),
      extractedFactModel.countDocuments({ documentVersionId: version._id, tenantId }),
    ]);

    fixtures.push({
      filename: document.title,
      documentId: documentIdStr,
      documentVersionId,
      chunksCreated,
      factsCreated,
    });
    filenameByDocVersionId.set(documentVersionId, document.title);
  }

  return { fixtures, filenameByDocVersionId };
}
