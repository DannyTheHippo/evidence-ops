import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose, { type Connection, type Model } from 'mongoose';
import {
  CanonicalEntity,
  CanonicalEntitySchema,
  type CanonicalEntityDocument,
} from '../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import {
  Conflict,
  ConflictSchema,
  type ConflictDocument,
} from '../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentSchema,
  type DocumentDocument,
} from '../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
  type DocumentVersionDocument,
} from '../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
  type EvidenceChunkDocument,
} from '../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import type {
  PdfPageLocator,
  XlsxCellLocator,
} from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  ExtractedFact,
  ExtractedFactSchema,
  type ExtractedFactDocument,
} from '../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  MetricPack,
  MetricPackSchema,
  type MetricPackDocument,
} from '../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import {
  MetricPolicy,
  MetricPolicySchema,
  type MetricPolicyDocument,
} from '../../src/database/schemas/evidence/metric-policy/metric-policy.schema';
import type { ApprovalDocument } from '../../src/database/schemas/workflow/approval/approval.schema';
import { ConflictsService } from '../../src/features/evidence/conflicts/conflicts.service';
import { CanonicalEntityService } from '../../src/features/evidence/facts/canonical-entity.service';
import { FactsService } from '../../src/features/evidence/facts/facts.service';
import { MetricPacksService } from '../../src/features/evidence/facts/metric-packs.service';
import { MetricPoliciesService } from '../../src/features/evidence/facts/metric-policies.service';
import { PASS_COUNT } from '../../src/features/evidence/facts/prose-fact-extractor';
import { IngestionService } from '../../src/features/evidence/ingestion/ingestion.service';
import { ParserRegistry } from '../../src/features/evidence/ingestion/parser.registry';
import { PdfParser } from '../../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../../src/features/evidence/ingestion/parsers/xlsx.parser';
import type { WorkflowRunsService } from '../../src/features/evidence/workflow-runs/workflow-runs.service';
import { FakeEmbeddingProvider } from '../../src/providers/embedding/fake-embedding.provider';
import { FakeModelProvider } from '../../src/providers/model/fake-model.provider';
import { FakeDocumentStore } from '../../src/providers/storage/fake-document.store';
import { FakeWorkflowEngine } from '../../src/providers/workflow-engine/fake-workflow.engine';
import type { AppLogger } from '../../src/shared/services/logger/logger.service';
import type { AuditService } from '../../src/shared/services/audit/audit.service';
import { getMockLogger } from '../utils/get-mock-logger';
import { getMockTypedConfig } from '../utils/get-mock-typed-config';

/**
 * Proves the vertical slice the plan calls out as never having been exercised together: real
 * `comps.xlsx`/`valuation-memo.pdf` fixtures run through the actual chunk+embed → extract facts →
 * scan-for-conflicts chain `ingest-document-version.workflow.ts` orchestrates, ending in the one
 * seeded cap-rate conflict (`fixtures/data-room/manifest.json`'s `conflict` block) with real
 * `xlsx-cell`/`pdf-page` provenance — not the hand-authored fact objects `detect-conflicts.spec.ts`
 * and `conflicts.service.spec.ts` use.
 *
 * Requires a real Mongo (`docker compose up -d mongo`; see `CLAUDE.md` § Validation) rather than
 * `mongodb-memory-server`: same reasoning as `mongo-hybrid.store.integration-spec.ts` for *that*
 * suite's Atlas Search dependency, but here the constraint is different — this environment's
 * sandbox blocks every socket bind, including the one `mongodb-memory-server` itself needs to
 * spawn a local `mongod`, so even a plain-CRUD Mongo test (no `$search`/`$vectorSearch` involved
 * anywhere in this chain) cannot run as an ordinary e2e spec here. Matched by
 * `*.integration-spec.ts`, run only via `npm run test:integration`, never by `npm test` or CI.
 *
 * Services are constructed directly (`new IngestionService(...)`, etc.) against a hand-built
 * Mongoose connection rather than through `AppModule`/`Test.createTestingModule` — this test needs
 * no HTTP surface, no auth, and no zod environment validation, just the same DI graph
 * `createActivities` (`src/worker/activities.ts`) wires at runtime, reproduced by hand. `Fake*`
 * providers stand in for the model/embedding calls (determinism); `FakeDocumentStore` is real,
 * in-memory storage for the fixture bytes, shared across `IngestionService` and `FactsService` the
 * same way `ProvidersModule`'s single `DOCUMENT_STORE` binding is shared in production.
 */
const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

const FIXTURES = path.join(__dirname, '../../fixtures/data-room');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';
const TENANT_ID = `ingest-pipeline-it-${randomUUID()}`;

describe('Ingest → facts → conflicts pipeline (integration)', () => {
  let connection: Connection;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let conflictModel: Model<ConflictDocument>;
  let canonicalEntityModel: Model<CanonicalEntityDocument>;
  let metricPackModel: Model<MetricPackDocument>;
  let metricPolicyModel: Model<MetricPolicyDocument>;

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_DB_URI).asPromise();
    // `SchemaFactory.createForClass` types each schema against its own undecorated class, not the
    // exported `XDocument` alias (`HydratedDocument<WithTimestamps<X>>`) — `connection.model<T>()`
    // can't unify the two through a single generic parameter, so each cast bridges the schema's
    // own type to the hydrated-document type every service in this test expects, mirroring
    // `xlsx.parser.ts`'s identical cast-through-`unknown` for a comparable third-party generic gap.
    documentModel = connection.model(
      Document.name,
      DocumentSchema,
    ) as unknown as Model<DocumentDocument>;
    documentVersionModel = connection.model(
      DocumentVersion.name,
      DocumentVersionSchema,
    ) as unknown as Model<DocumentVersionDocument>;
    evidenceChunkModel = connection.model(
      EvidenceChunk.name,
      EvidenceChunkSchema,
    ) as unknown as Model<EvidenceChunkDocument>;
    extractedFactModel = connection.model(
      ExtractedFact.name,
      ExtractedFactSchema,
    ) as unknown as Model<ExtractedFactDocument>;
    conflictModel = connection.model(
      Conflict.name,
      ConflictSchema,
    ) as unknown as Model<ConflictDocument>;
    canonicalEntityModel = connection.model(
      CanonicalEntity.name,
      CanonicalEntitySchema,
    ) as unknown as Model<CanonicalEntityDocument>;
    metricPackModel = connection.model(
      MetricPack.name,
      MetricPackSchema,
    ) as unknown as Model<MetricPackDocument>;
    metricPolicyModel = connection.model(
      MetricPolicy.name,
      MetricPolicySchema,
    ) as unknown as Model<MetricPolicyDocument>;
  });

  afterAll(async () => {
    if (connection) {
      await Promise.all([
        documentModel.deleteMany({ tenantId: TENANT_ID }),
        documentVersionModel.deleteMany({ tenantId: TENANT_ID }),
        evidenceChunkModel.deleteMany({ tenantId: TENANT_ID }),
        extractedFactModel.deleteMany({ tenantId: TENANT_ID }),
        conflictModel.deleteMany({ tenantId: TENANT_ID }),
        canonicalEntityModel.deleteMany({ tenantId: TENANT_ID }),
        metricPackModel.deleteMany({ tenantId: TENANT_ID }),
        metricPolicyModel.deleteMany({ tenantId: TENANT_ID }),
      ]);
      await connection.close();
    }
  });

  it('ingests comps.xlsx and valuation-memo.pdf, extracts facts, and detects the seeded cap-rate conflict with real provenance', async () => {
    const documentStore = new FakeDocumentStore();
    const embeddingProvider = new FakeEmbeddingProvider();
    const modelProvider = new FakeModelProvider();
    const parserRegistry = new ParserRegistry([new PdfParser(), new XlsxParser()]);
    const logger = getMockLogger() as unknown as AppLogger;
    const auditService = { record: jest.fn() } as unknown as AuditService;

    const ingestionService = new IngestionService(
      documentVersionModel,
      evidenceChunkModel,
      documentStore,
      embeddingProvider,
      parserRegistry,
      connection,
      logger,
    );
    // No canonical-entity rows are seeded for this tenant, so every candidate's entity resolves
    // unmatched and passes through unchanged — the pipeline's real-fixture assertions below are
    // about ingestion, extraction, and conflict detection, not entity canonicalization.
    const canonicalEntityService = new CanonicalEntityService(
      canonicalEntityModel,
      auditService,
      logger,
    );
    // This pipeline never activates a pack — it only reads the code default via `resolveActive` —
    // so a real WorkflowEngine/WorkflowRunsService is unneeded for `MetricPacksService` either; the
    // fake and a minimal stub satisfy the constructor without pulling Temporal or another Mongo
    // model into this integration lane. Built once, here, and reused below by `ConflictsService`.
    const workflowEngine = new FakeWorkflowEngine();
    const workflowRunsService = { create: jest.fn() } as unknown as WorkflowRunsService;
    // No `MetricPack` row is seeded for this tenant, so extraction resolves to the code default
    // `CRE_PACK_V1` — the same ontology this pipeline exercised before packs existed.
    const metricPacksService = new MetricPacksService(
      metricPackModel,
      workflowEngine,
      workflowRunsService,
      auditService,
      logger,
    );
    const factsService = new FactsService(
      documentVersionModel,
      evidenceChunkModel,
      extractedFactModel,
      documentStore,
      modelProvider,
      parserRegistry,
      canonicalEntityService,
      metricPacksService,
      getMockTypedConfig(),
      logger,
    );
    // This pipeline never resolves a conflict — it only detects one — so the same
    // `workflowEngine`/`workflowRunsService` fakes built above for `MetricPacksService` satisfy
    // `ConflictsService`'s constructor too. `requestResolution`'s pending-approval guard is likewise
    // never exercised, so `approvalModel` is the same kind of unused-but-required stub.
    const approvalModel = { exists: jest.fn() } as unknown as Model<ApprovalDocument>;
    // No tenant rows are seeded in `metric_policies` either, and no `MetricPack` row is seeded for
    // this tenant either (same `metricPacksService` above), so this resolves to the code default
    // `CRE_PACK_V1`'s own defaults — the same byte-identical-to-today behaviour `MetricPoliciesService
    // .resolveForTenant`'s own doc comment guarantees.
    const metricPoliciesService = new MetricPoliciesService(
      metricPolicyModel,
      metricPacksService,
      auditService,
      logger,
    );
    const conflictsService = new ConflictsService(
      extractedFactModel,
      conflictModel,
      documentVersionModel,
      documentModel,
      approvalModel,
      workflowEngine,
      workflowRunsService,
      metricPoliciesService,
      metricPacksService,
      auditService,
      logger,
    );

    // --- comps.xlsx: the current-underwriting cap rate (5.25%, cell Comps!F2) ---
    const compsBytes = await readFile(path.join(FIXTURES, 'comps.xlsx'));
    const compsDocument = await documentModel.create({
      title: 'Comparables',
      sourceKind: 'xlsx',
      mimeType: XLSX_MIME,
      tenantId: TENANT_ID,
    });
    const compsStored = await documentStore.put({
      content: compsBytes,
      contentType: XLSX_MIME,
      metadata: {},
    });
    const compsVersion = await documentVersionModel.create({
      documentId: compsDocument._id,
      versionNumber: 1,
      sha256: createHash('sha256').update(compsBytes).digest('hex'),
      sizeBytes: compsBytes.byteLength,
      storageKey: compsStored.id,
      tenantId: TENANT_ID,
    });

    // --- valuation-memo.pdf: the earlier-draft cap rate (6.10%, page 2) ---
    const memoBytes = await readFile(path.join(FIXTURES, 'valuation-memo.pdf'));
    const memoDocument = await documentModel.create({
      title: 'Valuation Memo',
      sourceKind: 'pdf',
      mimeType: PDF_MIME,
      tenantId: TENANT_ID,
    });
    const memoStored = await documentStore.put({
      content: memoBytes,
      contentType: PDF_MIME,
      metadata: {},
    });
    const memoVersion = await documentVersionModel.create({
      documentId: memoDocument._id,
      versionNumber: 1,
      sha256: createHash('sha256').update(memoBytes).digest('hex'),
      sizeBytes: memoBytes.byteLength,
      storageKey: memoStored.id,
      tenantId: TENANT_ID,
    });

    // Step 1 (chunk+embed): real parsers, real chunker, fake embeddings — mirrors what the
    // workflow's `ingestActivities.ingestDocumentVersion` activity does for each version.
    const compsIngest = await ingestionService.ingestVersion(
      compsVersion._id.toString(),
      TENANT_ID,
    );
    const memoIngest = await ingestionService.ingestVersion(memoVersion._id.toString(), TENANT_ID);
    expect(compsIngest.chunksCreated).toBeGreaterThan(0);
    expect(memoIngest.chunksCreated).toBeGreaterThan(0);

    // Step 2a (extract facts, spreadsheet path): deterministic regex extraction, no model call.
    const compsFacts = await factsService.extractFacts(compsVersion._id.toString(), TENANT_ID);
    expect(compsFacts.factsCreated).toBeGreaterThan(0);

    // Step 2b (extract facts, prose path): one FakeModelProvider result per persisted chunk,
    // built from the chunk's *actual* text rather than the manifest's context string — the exact
    // substring PDF extraction produces (spacing, hyphenation) is an implementation detail of
    // pdf.js, and `extractProseFacts` drops any candidate whose quote is not a literal substring
    // of the chunk it was extracted from.
    const memoChunks = await evidenceChunkModel
      .find({ documentVersionId: memoVersion._id })
      .sort({ _id: 1 });
    expect(memoChunks.length).toBeGreaterThan(0);

    let queuedCapRateFact = false;
    for (const chunk of memoChunks) {
      const idx = chunk.text.indexOf('6.10');
      if (idx === -1) {
        // `PASS_COUNT` results per chunk, not one: `extractProseFacts` runs that many independent
        // passes and `agreeFacts` keeps only groups at least two of them agree on. Enqueueing a
        // single result leaves passes 2..N with an empty queue, so the majority is never reached
        // and the chunk is skipped — which surfaces as `factsCreated: 0`, not as a queue error.
        // Imported rather than hardcoded so this cannot drift from the extractor again.
        for (let pass = 0; pass < PASS_COUNT; pass++) {
          modelProvider.enqueueResult({ output: { facts: [] } });
        }
        continue;
      }
      queuedCapRateFact = true;
      const quote = chunk.text.slice(Math.max(0, idx - 20), Math.min(chunk.text.length, idx + 10));
      for (let pass = 0; pass < PASS_COUNT; pass++) {
        modelProvider.enqueueResult({
          output: {
            facts: [
              {
                entity: 'Northgate Business Park',
                metric: 'cap_rate',
                // Derives to '2025-03' via `derivePeriodFromDateText` — must match the period the
                // xlsx extractor derives from comps.xlsx's Sale Date column for this same row, or
                // the two facts never share a `FactKey` and no conflict groups them together.
                periodText: 'March 2025',
                observedAtText: '',
                amount: 6.1,
                unit: 'percent',
                quote,
                confidence: 0.9,
              },
            ],
          },
        });
      }
    }
    // A test whose chunker output changed enough that no chunk contains the seeded figure would
    // otherwise pass vacuously (zero facts, zero conflicts) — fail loudly instead.
    expect(queuedCapRateFact).toBe(true);

    const memoFacts = await factsService.extractFacts(memoVersion._id.toString(), TENANT_ID);
    expect(memoFacts.factsCreated).toBeGreaterThan(0);

    // Step 3 (scan for conflicts): pure Mongo read-then-insert across both versions' facts.
    const scanResult = await conflictsService.scanForConflicts(TENANT_ID);
    expect(scanResult.conflictsCreated).toBe(1);

    const conflict = await conflictModel.findOne({
      tenantId: TENANT_ID,
      'factKey.entity': 'Northgate Business Park',
      'factKey.metric': 'cap_rate',
    });
    expect(conflict).not.toBeNull();
    expect(conflict?.factKey.period).toBe('2025-03');
    // 5.25% vs 6.10%, normalized to the ratio canonical unit — the exact spread the seeded
    // conflict's `note` field in manifest.json describes.
    expect(conflict?.magnitude).toBeCloseTo(0.0085, 4);
    expect(conflict?.status).toBe('open');
    expect(conflict?.factIds).toHaveLength(2);

    const conflictingFacts = await extractedFactModel.find({
      _id: { $in: conflict?.factIds ?? [] },
    });
    expect(conflictingFacts).toHaveLength(2);

    // The acceptance that matters: one xlsx-cell provenance, one pdf-page provenance — produced
    // by the real pipeline, not asserted against hand-authored fact objects.
    const locatorKinds = conflictingFacts.map((fact) => fact.locator.kind).sort();
    expect(locatorKinds).toEqual(['pdf-page', 'xlsx-cell']);

    const xlsxFact = conflictingFacts.find((fact) => fact.locator.kind === 'xlsx-cell');
    const xlsxLocator = xlsxFact?.locator as XlsxCellLocator;
    expect(xlsxLocator.sheetName).toBe('Comps');
    expect(xlsxLocator.cell).toBe('F2');
    // Field-by-field, not `toEqual` against the whole subdocument: `value` is a Mongoose
    // subdocument, and jest's deep equality walks its function properties, which throws under
    // strict mode ("'caller', 'callee', and 'arguments' properties may not be accessed").
    expect(xlsxFact?.value.amount).toBe(5.25);
    expect(xlsxFact?.value.unit).toBe('percent');

    const pdfFact = conflictingFacts.find((fact) => fact.locator.kind === 'pdf-page');
    const pdfLocator = pdfFact?.locator as PdfPageLocator;
    expect(pdfLocator.page).toBe(2);
    expect(pdfFact?.value.amount).toBe(6.1);
    expect(pdfFact?.value.unit).toBe('percent');
  }, 60000);
});
