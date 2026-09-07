import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from 'mongodb';
import type { Model } from 'mongoose';
import { CANONICAL_ENTITY_SEEDS } from '../scripts/fixtures/lib/constants';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
} from '../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  Tenant,
  TenantDocument,
} from '../src/database/schemas/administration/tenant/tenant.schema';
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
  type DocumentSourceClass,
} from '../src/database/schemas/evidence/document/document.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { Measure, MeasureDocument } from '../src/database/schemas/evidence/measure/measure.schema';
import { MIME_TYPE_TO_SOURCE_KIND } from '../src/features/evidence/documents/documents.constant';
import { FactsService } from '../src/features/evidence/facts/facts.service';
import { IngestionService } from '../src/features/evidence/ingestion/ingestion.service';
import { seedMeasures } from '../src/features/evidence/measures/measure-seed';
import {
  createSearchChunkCountProbe,
  createVectorChunkProbe,
  waitForIndexConvergence,
} from '../src/features/evidence/retrieval/search-index-readiness.util';
import {
  COLLECTION as EVIDENCE_CHUNKS_COLLECTION,
  SEARCH_INDEX,
  VECTOR_INDEX,
} from '../src/providers/retrieval/retrieval.constant';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../src/providers/storage/document-store.interface';
import { DATA_ROOM_DIR } from './resolve-locator';

/**
 * The eval corpus, and the reason this map exists rather than a directory scan: every entry needs a
 * MIME type the ingestion path recognises, and a fixture reaching the corpus without one would fail
 * at ingest rather than be skipped.
 *
 * It MUST list every file `fixtures/data-room/manifest.json` records a conflict against. A fixture
 * present in the manifest but absent here produces a conflict the corpus cannot form: the eval case
 * fails, and it fails as "insufficient evidence" — indistinguishable from a detection bug — while
 * the manifest goes on documenting a disagreement that never happens.
 */
const FIXTURE_MIME_TYPES: Readonly<Record<string, string>> = {
  'comps.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // The other half of the seeded cross-format NOI conflict; `comps.xlsx` carries the first.
  'noi-summary.csv': 'text/csv',
  'lease-summary.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'market-overview.pdf': 'application/pdf',
  'valuation-memo.pdf': 'application/pdf',
  'kestrel-point-pm-export.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'kestrel-point-comp-extract.pdf': 'application/pdf',
  'kestrel-point-crm-export.csv': 'text/csv',
  'kestrel-point-flyer-export.csv': 'text/csv',
};

/**
 * `sourceClass` for the `kestrel-point-*` fixtures — every other fixture stays at the schema's
 * `'unclassified'` default. `resolve-conflict-policy.ts` only proposes an `'authority'` winner
 * when every candidate fact's document carries a `sourceClass` in the metric's configured
 * `authorityOrder`, so the building-area conflict (`SEEDED_AREA_CONFLICT`) needs these classes
 * set to be resolvable at all.
 */
const FIXTURE_SOURCE_CLASSES: Readonly<Partial<Record<string, DocumentSourceClass>>> = {
  'kestrel-point-pm-export.xlsx': 'pm-export',
  'kestrel-point-comp-extract.pdf': 'spreadsheet',
  'kestrel-point-crm-export.csv': 'crm-export',
  'kestrel-point-flyer-export.csv': 'crm-export',
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
 *
 * FAILURE DIRECTION: fails CLOSED on index convergence, unlike `IngestionService.ingestVersion`'s
 * own best-effort (`onTimeout: 'degrade'`) check on the same write. `waitForIndexConvergence` here
 * uses its `'throw'` default deliberately — this is the exact defect the convergence probe exists
 * to close (see `search-index-readiness.util.ts`'s module doc): Atlas can report the search index
 * `queryable` before it has actually absorbed this fixture's chunks, and an eval run that queries
 * an unconverged corpus records a silently wrong `recall@k` rather than a loud failure. `--ingest`
 * already accepts a `db` handle from `run.ts` (`assertAtlasSearchSupported`'s same precondition
 * check runs there before any fixture is ingested), so this reuses it rather than re-resolving the
 * connection.
 */
export async function ingestFixtures(
  app: INestApplicationContext,
  tenantId: string,
  db: Db,
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
  const canonicalEntityModel = app.get<Model<CanonicalEntityDocument>>(
    getModelToken(CanonicalEntity.name),
  );
  const tenantModel = app.get<Model<TenantDocument>>(getModelToken(Tenant.name));
  const measureModel = app.get<Model<MeasureDocument>>(getModelToken(Measure.name));
  const documentStore = app.get<DocumentStore>(DOCUMENT_STORE);
  const ingestionService = app.get(IngestionService);
  const factsService = app.get(FactsService);

  await Promise.all([
    documentModel.deleteMany({ tenantId }),
    documentVersionModel.deleteMany({ tenantId }),
    evidenceChunkModel.deleteMany({ tenantId }),
    extractedFactModel.deleteMany({ tenantId }),
    conflictModel.deleteMany({ tenantId }),
    canonicalEntityModel.deleteMany({ tenantId }),
    measureModel.deleteMany({ tenantId }),
  ]);

  // The eval corpus is a real tenant, not a bare `tenantId` string on a pile of documents. Without
  // this row every operator path that validates the tenant registry — `scripts/co-tenant-user.ts`
  // most visibly — correctly refuses to touch the corpus, because as far as the product is
  // concerned no such tenant exists. Upserted rather than created so a re-ingest is idempotent.
  await tenantModel.updateOne(
    { tenantId },
    { $setOnInsert: { tenantId, name: 'Eval corpus' } },
    { upsert: true },
  );

  // Seeds the eval tenant's measures fresh on every run — `factsService.extractFacts` below reads
  // them via `loadExtractionContext`, so a corpus with no measures would extract zero facts.
  await seedMeasures(measureModel, tenantId);

  // Registers every property the corpus names in a seeded conflict — a real pilot tenant's
  // consultant registers the estate, not just the one property (Kestrel) that happens to need an
  // alias. `FactsService.extractFacts` canonicalizes every candidate's entity text against this
  // registry before `groupKey` computes `groupKeyNormalized`, so Kestrel's row is what makes the
  // flyer's alias resolve to the same group as the other three `kestrel-point-*` documents; the
  // other two rows carry no alias and change no existing fact's grouping.
  await canonicalEntityModel.create(
    CANONICAL_ENTITY_SEEDS.map((seed) => ({
      tenantId,
      canonicalName: seed.canonicalName,
      aliases: [...seed.aliases],
    })),
  );

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
      // Absent for every fixture but `kestrel-point-*` — `sourceClass` then falls back to the
      // schema's `'unclassified'` default, unchanged from before `FIXTURE_SOURCE_CLASSES` existed.
      sourceClass: FIXTURE_SOURCE_CLASSES[filename],
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
    const ingestionResult = await ingestionService.ingestVersion(documentVersionId, tenantId);

    if (ingestionResult.chunksCreated > 0) {
      // Any one of this version's chunks works as the vector probe's known document — `.lean()`
      // reads only `_id`/`embedding` back off the write this loop iteration just made, rather than
      // hydrating a full Mongoose document for values nothing here uses.
      const knownChunk = await evidenceChunkModel
        .findOne({ documentVersionId: version._id, tenantId })
        .select({ embedding: 1 })
        .lean();
      if (!knownChunk) {
        // Invariant guard, not a normal input-validation branch: `ingestVersion` just reported
        // `chunksCreated > 0` for this exact `documentVersionId`/`tenantId`, so a miss here means
        // the write this function just awaited is not yet visible to a plain (non-`$search`) read
        // on the same connection — a correctness bug that has nothing to do with index
        // convergence and must not be swallowed by the probe timeout below.
        throw new Error(
          `IngestionService reported ${ingestionResult.chunksCreated} chunk(s) created for ` +
            `document version '${documentVersionId}' but none are readable back from ` +
            `evidence_chunks immediately afterward`,
        );
      }

      await waitForIndexConvergence(
        db,
        EVIDENCE_CHUNKS_COLLECTION,
        SEARCH_INDEX,
        createSearchChunkCountProbe(
          db,
          EVIDENCE_CHUNKS_COLLECTION,
          SEARCH_INDEX,
          documentVersionId,
          ingestionResult.chunksCreated,
        ),
      );
      await waitForIndexConvergence(
        db,
        EVIDENCE_CHUNKS_COLLECTION,
        VECTOR_INDEX,
        createVectorChunkProbe(
          db,
          EVIDENCE_CHUNKS_COLLECTION,
          VECTOR_INDEX,
          tenantId,
          knownChunk._id,
          knownChunk.embedding,
        ),
      );
    }

    const factsResult = await factsService.extractFacts(documentVersionId, tenantId);

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
