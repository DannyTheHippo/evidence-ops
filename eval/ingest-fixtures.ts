import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from 'mongoose';
import {
  Conflict,
  ConflictDocument,
} from '../src/database/schemas/evidence/conflict/conflict.schema';
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
import { MIME_TYPE_TO_SOURCE_KIND } from '../src/features/evidence/documents/documents.constant';
import { FactsService } from '../src/features/evidence/facts/facts.service';
import { IngestionService } from '../src/features/evidence/ingestion/ingestion.service';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../src/providers/storage/document-store.interface';
import { DATA_ROOM_DIR } from './resolve-locator';

const FIXTURE_MIME_TYPES: Readonly<Record<string, string>> = {
  'comps.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'lease-summary.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'market-overview.pdf': 'application/pdf',
  'valuation-memo.pdf': 'application/pdf',
};

export interface IngestedFixture {
  readonly filename: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunksCreated: number;
  readonly factsCreated: number;
}

export interface IngestFixturesResult {
  readonly fixtures: readonly IngestedFixture[];
  readonly filenameByDocVersionId: ReadonlyMap<string, string>;
}

/**
 * Bypasses `DocumentsService.upload`, which fire-and-forgets an `ingestDocumentVersion` Temporal
 * workflow that has no worker to pick it up (Temporal is scaffolded but not wired — see
 * `.claude/CLAUDE.md`'s "not wired" note). Instead writes bytes to the document store, creates
 * `Document`/`DocumentVersion` rows directly, and calls `IngestionService.ingestVersion` +
 * `FactsService.extractFacts` synchronously — the same two services `src/worker/activities.ts`
 * exposes to a real Temporal worker, called here in the order the `ingestDocumentVersion` workflow
 * would have run them, just without a workflow engine in between.
 *
 * Deletes every row already tagged with `tenantId` first: the sha256-dedupe that makes
 * `DocumentsService.addVersion` idempotent across re-uploads never runs on this path (there is no
 * existing `documentId` to dedupe against), so a second eval run against the same Mongo would
 * otherwise duplicate every chunk and fact under the eval tenant and silently inflate retrieval
 * recall with duplicate hits. Scoped to `tenantId` alone — never touches `DEFAULT_TENANT_ID`'s
 * rows, since the eval harness may run against a shared dev Mongo instance.
 */
export async function ingestFixtures(
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
  const conflictModel = app.get<Model<ConflictDocument>>(getModelToken(Conflict.name));
  const documentStore = app.get<DocumentStore>(DOCUMENT_STORE);
  const ingestionService = app.get(IngestionService);
  const factsService = app.get(FactsService);

  await Promise.all([
    documentModel.deleteMany({ tenantId }),
    documentVersionModel.deleteMany({ tenantId }),
    evidenceChunkModel.deleteMany({ tenantId }),
    extractedFactModel.deleteMany({ tenantId }),
    conflictModel.deleteMany({ tenantId }),
  ]);

  const fixtures: IngestedFixture[] = [];
  const filenameByDocVersionId = new Map<string, string>();

  for (const [filename, mimeType] of Object.entries(FIXTURE_MIME_TYPES)) {
    const sourceKind = MIME_TYPE_TO_SOURCE_KIND[mimeType];
    if (!sourceKind) {
      // Invariant guard, not a normal input-validation branch: `FIXTURE_MIME_TYPES` above is
      // hand-authored against the exact same allowlist `MIME_TYPE_TO_SOURCE_KIND` defines, so a
      // miss here means the two have drifted apart, not that a real upload used an unsupported type.
      throw new Error(
        `No source kind registered for MIME type '${mimeType}' (fixture '${filename}')`,
      );
    }

    const buffer = await readFile(path.join(DATA_ROOM_DIR, filename));
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    const document = await documentModel.create({
      title: filename,
      sourceKind,
      mimeType,
      tenantId,
    });

    const stored = await documentStore.put({
      content: buffer,
      contentType: mimeType,
      metadata: {},
    });

    const version = await documentVersionModel.create({
      documentId: document._id,
      versionNumber: 1,
      sha256,
      sizeBytes: buffer.length,
      storageKey: stored.id,
      tenantId,
    });

    document.currentVersionId = version._id;
    await document.save();

    const documentVersionId = version._id.toString();
    const ingestionResult = await ingestionService.ingestVersion(documentVersionId);
    const factsResult = await factsService.extractFacts(documentVersionId);

    fixtures.push({
      filename,
      documentId: document._id.toString(),
      documentVersionId,
      chunksCreated: ingestionResult.chunksCreated,
      factsCreated: factsResult.factsCreated,
    });
    filenameByDocVersionId.set(documentVersionId, filename);
  }

  return { fixtures, filenameByDocVersionId };
}
