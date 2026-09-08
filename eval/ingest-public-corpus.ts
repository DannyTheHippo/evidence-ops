import 'dotenv/config';

import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Model } from 'mongoose';
import { laneConfig } from './lanes';
import { sha256Hex } from '../scripts/fixtures/lib/hash';
import {
  readCorpusManifest,
  selectedFiles,
  type CorpusManifest,
} from '../scripts/public-corpus/lib/corpus-manifest';
import {
  Tenant,
  TenantDocument,
} from '../src/database/schemas/administration/tenant/tenant.schema';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
  normalizeEntityName,
} from '../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
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
import {
  Measure,
  MeasureDocument,
  type MeasureUnit,
} from '../src/database/schemas/evidence/measure/measure.schema';
import {
  SOURCE_KIND_TO_MIME_TYPE,
  UPLOAD_EXTENSION_ALLOWLIST,
} from '../src/features/evidence/documents/documents.constant';
import type { FactValueType, ToleranceKind } from '../src/features/evidence/facts/metric-ontology';
import { FactsService } from '../src/features/evidence/facts/facts.service';
import { IngestionService } from '../src/features/evidence/ingestion/ingestion.service';
import { seedMeasures } from '../src/features/evidence/measures/measure-seed';
import {
  createSearchChunkCountProbe,
  createVectorChunkProbe,
  waitForIndexConvergence,
} from '../src/features/evidence/retrieval/search-index-readiness.util';
import { TenantSpendLimitExceededError } from '../src/providers/model/errors/tenant-spend-limit-exceeded.error';
import {
  COLLECTION as EVIDENCE_CHUNKS_COLLECTION,
  SEARCH_INDEX,
  VECTOR_INDEX,
} from '../src/providers/retrieval/retrieval.constant';
import { assertAtlasSearchSupported } from '../src/providers/retrieval/atlas-search-capability.util';
import { assertRequiredSearchIndexesExist } from '../src/providers/retrieval/required-search-indexes.util';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../src/providers/storage/document-store.interface';
import measuresJson from './public/measures.json';

/**
 * `eval/public/measures.json`'s own shape — the REIT measures confirmed for the `eval-public`
 * tenant before extraction, projected the way `MeasuresService` has no manual-create path for
 * (Assumptions 6): `status`/`origin` are carried in the file for documentation, and this script
 * re-asserts `'confirmed'`/`'manual'`/`version: 1`/`proposedFrom: []` at insert time regardless of
 * what the file says, so the two can never drift apart.
 */
export interface PublicMeasureDefinition {
  readonly slug: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly valueType: FactValueType;
  readonly canonicalUnit: string;
  readonly units: readonly MeasureUnit[];
  readonly toleranceKind: ToleranceKind;
  readonly tolerance: number;
  readonly status: 'confirmed';
  readonly origin: 'manual';
}

export const PUBLIC_MEASURES: readonly PublicMeasureDefinition[] =
  measuresJson as readonly PublicMeasureDefinition[];

/** A file's terminal or in-progress ledger state. `'pending'` covers both "never attempted" (no
 *  entry at all) and "attempted, ingest itself did not finish" — the ingest-time spend-ceiling
 *  path below leaves an entry at `'pending'` rather than inventing a fifth state, since
 *  `IngestionService.ingestVersion` is already safely re-attemptable from that state
 *  (`ingestionStatus` tracks its own progress). `'facts-pending'` is the narrower case where
 *  ingest finished but extraction left chunks unextracted; `'failed'` is terminal either way. */
export interface IngestLedgerEntry {
  readonly path: string;
  readonly sha256: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly chunksCreated?: number;
  readonly proseChunks?: number;
  readonly factsCreated?: number;
  readonly skippedChunkCount?: number;
  readonly ingestMs?: number;
  readonly extractMs?: number;
  readonly state: 'pending' | 'ingested' | 'facts-pending' | 'failed';
  readonly attempts?: number;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface IngestLedger {
  readonly tenantId: string;
  readonly corpusManifestSha256: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly entries: Record<string, IngestLedgerEntry>;
}

/** `extractFacts` never surfaces a budget refusal as a thrown error (`facts.service.ts`'s own
 *  `skippedChunkCount` doc comment): a chunk the spend ceiling refused is silently counted as a
 *  non-vote. Three retries of the same suspected-ceiling document is a bound on how long a file
 *  can occupy an invocation before the operator's own daily-ceiling decision (Assumptions 1) is
 *  the more useful signal than another attempt. */
const MAX_FACTS_PENDING_ATTEMPTS = 3;

/**
 * The ordered list of corpus-relative paths this invocation should attempt: `selectedFiles`'
 * manifest order (registrant-allowlist order — never re-sorted lexicographically, since a
 * zero-padded CIK string-sorts nothing like the allowlist the whole selection rule is built
 * around), filtered to `options.only`'s prefix when given, and capped at `options.maxDocuments`.
 * A path already `'ingested'` or `'failed'` is terminal and excluded; `'facts-pending'` is
 * retried while `attempts` stays below {@link MAX_FACTS_PENDING_ATTEMPTS}; `'pending'` (including
 * a path absent from the ledger) is always retried. Pure — no I/O, no Mongo.
 */
export function planIngest(
  manifest: CorpusManifest,
  ledger: IngestLedger | undefined,
  options: { readonly maxDocuments?: number; readonly only?: string },
): readonly string[] {
  const plan: string[] = [];

  for (const file of selectedFiles(manifest)) {
    if (options.only && !file.path.startsWith(options.only)) {
      continue;
    }

    const entry = ledger?.entries[file.path];
    if (!entry || entry.state === 'pending') {
      plan.push(file.path);
      continue;
    }
    if (entry.state === 'facts-pending' && (entry.attempts ?? 0) < MAX_FACTS_PENDING_ATTEMPTS) {
      plan.push(file.path);
    }
  }

  return options.maxDocuments === undefined ? plan : plan.slice(0, options.maxDocuments);
}

/** Every selected file has a terminal ledger entry (`'ingested'` or `'failed'`) and none is
 *  `'facts-pending'` or `'pending'` — computed over the manifest's full selected set, not just
 *  the paths this one invocation planned, so a `--only`/`--max-documents`-bounded run never
 *  stamps `completedAt` for work it never attempted. */
function isRunComplete(manifest: CorpusManifest, ledger: IngestLedger): boolean {
  return selectedFiles(manifest).every((file) => {
    const state = ledger.entries[file.path]?.state;
    return state === 'ingested' || state === 'failed';
  });
}

function summarizeLedger(
  manifest: CorpusManifest,
  ledger: IngestLedger,
): { documents: number; chunks: number; prose: number; facts: number; failed: number } {
  let documents = 0;
  let chunks = 0;
  let prose = 0;
  let facts = 0;
  let failed = 0;
  for (const file of selectedFiles(manifest)) {
    const entry = ledger.entries[file.path];
    if (!entry) {
      continue;
    }
    if (entry.state === 'ingested') {
      documents += 1;
      chunks += entry.chunksCreated ?? 0;
      prose += entry.proseChunks ?? 0;
      facts += entry.factsCreated ?? 0;
    } else if (entry.state === 'failed') {
      failed += 1;
    }
  }
  return { documents, chunks, prose, facts, failed };
}

interface IngestPublicCorpusArgs {
  readonly maxDocuments?: number;
  readonly maxMinutes?: number;
  readonly only?: string;
}

function usage(): never {
  console.error(
    'usage: ingest-public-corpus.ts [--max-documents <n>] [--max-minutes <n>] [--only <path-prefix>]',
  );
  process.exit(1);
}

function parseArgs(argv: readonly string[]): IngestPublicCorpusArgs {
  let maxDocuments: number | undefined;
  let maxMinutes: number | undefined;
  let only: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-documents') {
      maxDocuments = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--max-minutes') {
      maxMinutes = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--only') {
      only = argv[index + 1];
      index += 1;
    } else if (arg === '--help') {
      usage();
    }
  }

  if (maxDocuments !== undefined && !Number.isFinite(maxDocuments)) {
    console.error('--max-documents must be a number');
    usage();
  }
  if (maxMinutes !== undefined && !Number.isFinite(maxMinutes)) {
    console.error('--max-minutes must be a number');
    usage();
  }

  return { maxDocuments, maxMinutes, only };
}

async function tryReadLedger(ledgerPath: string): Promise<IngestLedger | undefined> {
  try {
    const raw = await readFile(ledgerPath, 'utf-8');
    return JSON.parse(raw) as IngestLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Atomic: written to `<path>.tmp` then renamed over `path`, matching `corpus-manifest.ts`'s
 *  `writeCorpusManifest` — a killed write never leaves a partial ledger the next invocation could
 *  misread as complete. */
async function writeLedger(ledgerPath: string, ledger: IngestLedger): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const tmpPath = `${ledgerPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, ledgerPath);
}

function withEntry(ledger: IngestLedger, filePath: string, entry: IngestLedgerEntry): IngestLedger {
  return { ...ledger, entries: { ...ledger.entries, [filePath]: entry } };
}

/** `registrant.name` is the allowlist's own short display name (`fetch-edgar.ts` stores it
 *  verbatim, not EDGAR's returned legal name), so it rarely carries one of these suffixes; the
 *  rule still runs unconditionally, and a registrant whose name has no such suffix simply gets no
 *  extra alias. */
const ENTITY_SUFFIX_PATTERN = /,?\s+(inc\.?|trust|corporation|corp\.?|l\.?p\.?)$/i;

function deriveEntityAliases(name: string): string[] {
  const stripped = name.replace(ENTITY_SUFFIX_PATTERN, '').trim();
  return stripped.length > 0 && stripped !== name ? [stripped] : [];
}

/**
 * Idempotent per-tenant setup: upserts the `eval-public` tenant row, seeds the eight CRE
 * measures once (`MeasuresService` has no manual-create path — Assumptions 6), inserts every
 * `eval/public/measures.json` row not already present by slug, and registers every manifest
 * registrant as a canonical entity not already present by normalized name.
 */
async function ensureTenantSetUp(
  tenantModel: Model<TenantDocument>,
  measureModel: Model<MeasureDocument>,
  canonicalEntityModel: Model<CanonicalEntityDocument>,
  tenantId: string,
  manifest: CorpusManifest,
): Promise<void> {
  await tenantModel.updateOne(
    { tenantId },
    { $setOnInsert: { tenantId, name: 'Public corpus (SEC EDGAR REIT filings)' } },
    { upsert: true },
  );

  const measureCount = await measureModel.countDocuments({ tenantId });
  if (measureCount === 0) {
    await seedMeasures(measureModel, tenantId);
  }

  for (const measure of PUBLIC_MEASURES) {
    const exists = await measureModel.exists({ tenantId, slug: measure.slug });
    if (exists) {
      continue;
    }
    await measureModel.create({
      tenantId,
      slug: measure.slug,
      label: measure.label,
      aliases: [...measure.aliases],
      valueType: measure.valueType,
      canonicalUnit: measure.canonicalUnit,
      units: measure.units.map((unit) => ({ ...unit })),
      toleranceKind: measure.toleranceKind,
      tolerance: measure.tolerance,
      status: 'confirmed',
      origin: 'manual',
      proposedFrom: [],
      version: 1,
    });
  }

  for (const registrant of manifest.registrants) {
    const exists = await canonicalEntityModel
      .findOne({ tenantId, canonicalNameNormalized: normalizeEntityName(registrant.name) })
      .select({ _id: 1 })
      .lean();
    if (exists) {
      continue;
    }
    await canonicalEntityModel.create({
      tenantId,
      canonicalName: registrant.name,
      aliases: deriveEntityAliases(registrant.name),
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lane = laneConfig('public');
  if (!lane.corpusManifestPath || !lane.ledgerPath) {
    throw new Error(
      'eval:public:ingest: public lane config carries no corpusManifestPath/ledgerPath',
    );
  }

  const manifest = await readCorpusManifest(lane.corpusManifestPath);
  const manifestSha256 = sha256Hex(await readFile(lane.corpusManifestPath));

  // Every selected file's bytes are re-verified against the manifest's own sha256 before any
  // Mongo write — a corpus whose bytes drifted from what the manifest names must fail loudly
  // here, not mint a Document from bytes no citation can trust.
  for (const file of selectedFiles(manifest)) {
    const localPath = path.join(lane.corpusDir, file.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(localPath);
    } catch {
      throw new Error(
        `eval:public:ingest: missing corpus file '${localPath}' named in the manifest`,
      );
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(
        `eval:public:ingest: sha256 mismatch for '${localPath}' — corpus bytes do not match the manifest`,
      );
    }
  }

  const existingLedger = await tryReadLedger(lane.ledgerPath);
  if (existingLedger && existingLedger.corpusManifestSha256 !== manifestSha256) {
    throw new Error(
      `eval:public:ingest: ledger at '${lane.ledgerPath}' was built against a different corpus ` +
        `manifest (expected sha256 ${existingLedger.corpusManifestSha256}, current manifest hashes ` +
        `to ${manifestSha256}) — delete the ledger to re-ingest under the new manifest`,
    );
  }

  let ledger: IngestLedger = existingLedger ?? {
    tenantId: lane.tenantId,
    corpusManifestSha256: manifestSha256,
    startedAt: new Date().toISOString(),
    entries: {},
  };

  const plan = planIngest(manifest, ledger, { maxDocuments: args.maxDocuments, only: args.only });
  console.log(`eval:public:ingest: ${plan.length} document(s) planned this invocation`);
  // Written up front, even for an empty plan (`--max-documents 0`): the ledger exists on disk as
  // soon as this invocation has read the manifest, independent of whether any document is
  // actually attempted this run.
  await writeLedger(lane.ledgerPath, ledger);

  const deadline =
    args.maxMinutes === undefined ? undefined : Date.now() + args.maxMinutes * 60_000;
  let spendCeilingHit = false;

  // Required here, not at module top level: `./bootstrap` imports `AppModule`, whose decorators
  // evaluate `ConfigModule.forRoot()` at *import* time, reading `.env` as a side effect of the
  // import alone. A static import would make that read fire the moment anything (including
  // `ingest-public-corpus.spec.ts`, which only wants the pure exports above) requires this
  // module; `createRequire` matches `scripts/experiments/verifier/cli.ts`'s own use of the same
  // pattern for the same reason.
  const { bootstrapEvalApp, closeEvalApp } = createRequire(__filename)(
    './bootstrap',
  ) as typeof import('./bootstrap');

  const app = await bootstrapEvalApp({
    // Read-through: a re-run after a mid-run stop replays the passes already paid for.
    cacheMode: 'record',
    embeddingCacheMode: 'record',
    modelCacheDir: lane.modelCacheDir,
    embeddingCacheDir: lane.embeddingCacheDir,
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db) {
      throw new Error('eval:public:ingest: Mongo connection has no active database handle');
    }
    const db = connection.db;
    await assertAtlasSearchSupported(db);
    await assertRequiredSearchIndexesExist(db);

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
    const canonicalEntityModel = app.get<Model<CanonicalEntityDocument>>(
      getModelToken(CanonicalEntity.name),
    );
    const tenantModel = app.get<Model<TenantDocument>>(getModelToken(Tenant.name));
    const measureModel = app.get<Model<MeasureDocument>>(getModelToken(Measure.name));
    const documentStore = app.get<DocumentStore>(DOCUMENT_STORE);
    const ingestionService = app.get(IngestionService);
    const factsService = app.get(FactsService);

    await ensureTenantSetUp(
      tenantModel,
      measureModel,
      canonicalEntityModel,
      lane.tenantId,
      manifest,
    );

    for (const filePath of plan) {
      if (deadline !== undefined && Date.now() >= deadline) {
        console.log('eval:public:ingest: --max-minutes elapsed, stopping between documents');
        break;
      }

      const bytes = await readFile(path.join(lane.corpusDir, filePath));
      const sha256 = sha256Hex(bytes);
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const sourceKind = UPLOAD_EXTENSION_ALLOWLIST.get(extension);
      if (!sourceKind) {
        ledger = withEntry(ledger, filePath, {
          path: filePath,
          sha256,
          state: 'failed',
          error: `no source kind registered for extension '${extension}'`,
          attempts: (ledger.entries[filePath]?.attempts ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        await writeLedger(lane.ledgerPath, ledger);
        continue;
      }
      const mimeType = SOURCE_KIND_TO_MIME_TYPE[sourceKind];

      try {
        let version = await documentVersionModel.findOne({ tenantId: lane.tenantId, sha256 });
        let documentId: string;
        if (version) {
          documentId = version.documentId.toString();
        } else {
          const document = await documentModel.create({
            title: filePath,
            sourceKind,
            mimeType,
            tenantId: lane.tenantId,
            sourceClass: 'unclassified',
          });
          const stored = await documentStore.put({
            content: bytes,
            contentType: mimeType,
            metadata: {},
          });
          version = await documentVersionModel.create({
            documentId: document._id,
            versionNumber: 1,
            sha256,
            sizeBytes: bytes.length,
            storageKey: stored.id,
            tenantId: lane.tenantId,
          });
          document.currentVersionId = version._id;
          await document.save();
          documentId = document._id.toString();
        }
        const documentVersionId = version._id.toString();

        // Facts a completed ledger entry never recorded are never trusted: a crash between a
        // prior attempt's `extractFacts` and this script's own ledger write must not let
        // `extractFacts`'s existence check (`facts.service.ts`) read a partial extraction as
        // already done. Skipped only once the ledger itself says this path is `'ingested'`.
        if (ledger.entries[filePath]?.state !== 'ingested') {
          await extractedFactModel.deleteMany({
            documentVersionId: version._id,
            tenantId: lane.tenantId,
          });
        }

        const ingestStart = Date.now();
        let chunksCreated: number;
        try {
          chunksCreated = (await ingestionService.ingestVersion(documentVersionId, lane.tenantId))
            .chunksCreated;
        } catch (error) {
          if (error instanceof TenantSpendLimitExceededError) {
            ledger = withEntry(ledger, filePath, {
              path: filePath,
              sha256,
              documentId,
              documentVersionId,
              state: 'pending',
              error: error.message,
              attempts: (ledger.entries[filePath]?.attempts ?? 0) + 1,
              updatedAt: new Date().toISOString(),
            });
            await writeLedger(lane.ledgerPath, ledger);
            spendCeilingHit = true;
            console.log(
              `eval:public:ingest: spend ceiling refused while embedding '${filePath}' — stopping`,
            );
            break;
          }
          throw error;
        }
        const ingestMs = Date.now() - ingestStart;

        if (chunksCreated > 0) {
          const knownChunk = await evidenceChunkModel
            .findOne({ documentVersionId: version._id, tenantId: lane.tenantId })
            .select({ embedding: 1 })
            .lean();
          if (!knownChunk) {
            throw new Error(
              `ingestVersion reported ${chunksCreated} chunk(s) for '${filePath}' but none are ` +
                `readable back from evidence_chunks immediately afterward`,
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
              chunksCreated,
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
              lane.tenantId,
              knownChunk._id,
              knownChunk.embedding,
            ),
          );
        }

        const proseChunks = await evidenceChunkModel.countDocuments({
          documentVersionId: version._id,
          tenantId: lane.tenantId,
          'locator.kind': { $ne: 'xlsx-region' },
        });

        const extractStart = Date.now();
        const factsResult = await factsService.extractFacts(documentVersionId, lane.tenantId);
        const extractMs = Date.now() - extractStart;

        if (factsResult.skippedChunkCount > 0) {
          // Not short-circuited by a partial extraction on the next attempt (`facts.service.ts`
          // returns early once any facts exist for a version).
          await extractedFactModel.deleteMany({
            documentVersionId: version._id,
            tenantId: lane.tenantId,
          });
          const attempts = (ledger.entries[filePath]?.attempts ?? 0) + 1;
          const facsPendingState =
            attempts >= MAX_FACTS_PENDING_ATTEMPTS ? 'failed' : 'facts-pending';
          ledger = withEntry(ledger, filePath, {
            path: filePath,
            sha256,
            documentId,
            documentVersionId,
            chunksCreated,
            proseChunks,
            skippedChunkCount: factsResult.skippedChunkCount,
            ingestMs,
            extractMs,
            state: facsPendingState,
            ...(facsPendingState === 'failed' ? { error: 'spend-ceiling' } : {}),
            attempts,
            updatedAt: new Date().toISOString(),
          });
          await writeLedger(lane.ledgerPath, ledger);
          spendCeilingHit = true;
          console.log(
            `eval:public:ingest: '${filePath}' left ${factsResult.skippedChunkCount} chunk(s) ` +
              `unextracted (suspected spend ceiling) — attempt ${attempts}` +
              (facsPendingState === 'failed' ? ', marked failed' : ''),
          );
          break;
        }

        ledger = withEntry(ledger, filePath, {
          path: filePath,
          sha256,
          documentId,
          documentVersionId,
          chunksCreated,
          proseChunks,
          factsCreated: factsResult.factsCreated,
          skippedChunkCount: 0,
          ingestMs,
          extractMs,
          state: 'ingested',
          updatedAt: new Date().toISOString(),
        });
        await writeLedger(lane.ledgerPath, ledger);
        console.log(
          `eval:public:ingest:   ${filePath} -> ${chunksCreated} chunk(s) (${proseChunks} prose), ` +
            `${factsResult.factsCreated} fact(s)`,
        );
      } catch (error) {
        ledger = withEntry(ledger, filePath, {
          path: filePath,
          sha256,
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
          attempts: (ledger.entries[filePath]?.attempts ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        await writeLedger(lane.ledgerPath, ledger);
        console.error(
          `eval:public:ingest: '${filePath}' failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const complete = isRunComplete(manifest, ledger);
    if (complete && !ledger.completedAt) {
      ledger = { ...ledger, completedAt: new Date().toISOString() };
      await writeLedger(lane.ledgerPath, ledger);
    }

    const summary = summarizeLedger(manifest, ledger);
    console.log(
      `eval:public:ingest: ${complete ? 'complete' : 'stopped'} — ${summary.documents} document(s), ` +
        `${summary.chunks} chunk(s) (${summary.prose} prose), ${summary.facts} fact(s), ` +
        `${summary.failed} failed`,
    );

    if (spendCeilingHit) {
      process.exitCode = 2;
    }
  } finally {
    await closeEvalApp(app);
  }
}

// Guards the CLI's own I/O from running as a side effect of `ingest-public-corpus.spec.ts`
// importing the pure exports above — `require.main` is only the module itself when this file is
// the process entry point (`npx ts-node … ingest-public-corpus.ts`), never when Jest `require`s it
// as a library.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? `eval:public:ingest: fatal error — ${error.message}` : error,
    );
    process.exitCode = 1;
  });
}
