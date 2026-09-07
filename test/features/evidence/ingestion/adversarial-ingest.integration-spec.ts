import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import path from 'node:path';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import {
  User,
  UserSchema,
  type UserDocument,
} from '../../../../src/database/schemas/administration/user/user.schema';
import {
  Conflict,
  ConflictSchema,
  type ConflictDocument,
} from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
  type DocumentVersionDocument,
  type DocumentVersionIngestionStatus,
} from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  DocumentSchema,
  type DocumentDocument,
} from '../../../../src/database/schemas/evidence/document/document.schema';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
  type EvidenceChunkDocument,
} from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
  type ExtractedFactDocument,
} from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  Source,
  SourceSchema,
  type SourceDocument,
} from '../../../../src/database/schemas/evidence/source/source.schema';
import {
  DocumentsService,
  type UploadOutcome,
} from '../../../../src/features/evidence/documents/documents.service';
import { EmailAttachmentService } from '../../../../src/features/evidence/ingestion/email-attachment.service';
import { buildDocumentParsers } from '../../../../src/features/evidence/ingestion/ingestion.module';
import { IngestionService } from '../../../../src/features/evidence/ingestion/ingestion.service';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import { SourcesService } from '../../../../src/features/evidence/sources/sources.service';
import type { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import { FakeEmbeddingProvider } from '../../../../src/providers/embedding/fake-embedding.provider';
import { LocalFolderSourceConnector } from '../../../../src/providers/source-connector/local-folder-source.connector';
import { FakeDocumentStore } from '../../../../src/providers/storage/fake-document.store';
import { FakeWorkflowEngine } from '../../../../src/providers/workflow-engine/fake-workflow.engine';
import type { AuditService } from '../../../../src/shared/services/audit/audit.service';
import type { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';
import manifest from '../../../../fixtures/adversarial/manifest.json';

/**
 * Drives every fixture in `fixtures/adversarial/manifest.json` through the real upload gate and
 * the real ingest pipeline, then independently through the real sync path — the sweep 3A.4/3A.6/
 * 3A.7/3A.8 exercised one parser or one gate at a time, never the whole vertical slice together.
 * The property under test is the plan's own: every fixture reaches a terminal state (a gate
 * refusal, or `ingestionStatus` in `'completed' | 'failed' | 'needs-ocr'`), never `'pending'`.
 *
 * Requires a real Mongo, the same reasoning as `ingest-document-version.pipeline.integration-spec.ts`.
 * Services are hand-built against a raw Mongoose connection for the same reason that spec gives:
 * no HTTP surface, no auth, no zod environment validation is needed here, only the DI graph
 * `createActivities` wires at runtime, reproduced by hand. `FakeWorkflowEngine`/`FakeDocumentStore`/
 * `FakeEmbeddingProvider` stand in for Temporal, blob storage, and the embedding call; every parser,
 * `DocumentsService`, `EmailAttachmentService`, `IngestionService`, and `SourcesService` (with a
 * real `LocalFolderSourceConnector`) are the genuine article.
 */
const MONGO_DB_URI =
  process.env.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';

const FIXTURES = path.join(__dirname, '../../../../fixtures/adversarial');
const TENANT_ID = `adversarial-ingest-it-${randomUUID()}`;

/** Refused before any bytes are hashed or stored — `resolveUploadKind`/`contentMatchesDeclaredKind`
 *  (`documents.constant.ts`) reject these outright given `mimetype: ''` (the same ambiguous-MIME
 *  path a filesystem connector's `syncOneFile` always takes) and each fixture's own extension. */
const GATE_REFUSED_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['disguised-pdf.txt', 'ContentTypeMismatchException'],
  ['encrypted.docx', 'ContentTypeMismatchException'],
  ['legacy-memo.doc', 'UnresolvableContentTypeException'],
  ['legacy-ledger.xls', 'UnresolvableContentTypeException'],
]);

/**
 * Every manifest path that clears the upload gate reaches `ingestionStatus: 'completed'`, except
 * the ones named here: an unterminated `<script>` and a paragraph nested past
 * `HTML_MAX_NESTING_DEPTH` (`html.parser.ts`) both throw `MalformedHtmlException`; a truncated,
 * headerless, or over-deep-nested `.eml` throws inside `parseEmailMessage` before any chunk is
 * produced; and an honestly-typed `.eml` whose attachment's declared type contradicts its bytes
 * throws `HostileEmailException` out of `EmailAttachmentService.unwrapAttachments`. `truncated.pdf`
 * accepts either terminal failure status — `PdfParser` throws one of two exceptions for it
 * (`test/fixtures/adversarial-behavior.spec.ts` pins both as acceptable), and `IngestionService`
 * maps only `EmptyPdfTextLayerException` to `'needs-ocr'`.
 */
const EXPECTED_INGESTION_STATUS: ReadonlyMap<string, readonly DocumentVersionIngestionStatus[]> =
  new Map([
    ['email-disguised-attachment.eml', ['failed']],
    ['email-headerless.eml', ['failed']],
    ['email-nested-message.eml', ['failed']],
    ['email-truncated.eml', ['failed']],
    ['nested-tags.html', ['failed']],
    ['unterminated-script.html', ['failed']],
    ['truncated.pdf', ['failed', 'needs-ocr']],
  ]);

function expectedStatusesFor(fixturePath: string): readonly DocumentVersionIngestionStatus[] {
  return EXPECTED_INGESTION_STATUS.get(fixturePath) ?? ['completed'];
}

interface FixtureOutcome {
  readonly path: string;
  readonly outcome: string;
  readonly detail: string;
}

describe('Adversarial ingest sweep (integration)', () => {
  let connection: Connection;
  let documentModel: Model<DocumentDocument>;
  let documentVersionModel: Model<DocumentVersionDocument>;
  let evidenceChunkModel: Model<EvidenceChunkDocument>;
  let extractedFactModel: Model<ExtractedFactDocument>;
  let conflictModel: Model<ConflictDocument>;
  let userModel: Model<UserDocument>;
  let sourceModel: Model<SourceDocument>;

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_DB_URI).asPromise();
    // Same schema/hydrated-document generic bridge as `ingest-document-version.pipeline
    // .integration-spec.ts` — see that file's own comment for why the cast is needed.
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
    userModel = connection.model(User.name, UserSchema) as unknown as Model<UserDocument>;
    sourceModel = connection.model(Source.name, SourceSchema) as unknown as Model<SourceDocument>;

    // The tenant-wide `document_versions_tenantId_sha256_unique` index and `documents`' own
    // partial indexes are what the dedupe assertions below depend on — schema-declared, not
    // guaranteed present on a database this suite did not itself migrate.
    await documentVersionModel.syncIndexes();
    await documentModel.syncIndexes();
  });

  afterAll(async () => {
    if (connection) {
      await Promise.all([
        documentModel.deleteMany({ tenantId: TENANT_ID }),
        documentVersionModel.deleteMany({ tenantId: TENANT_ID }),
        evidenceChunkModel.deleteMany({ tenantId: TENANT_ID }),
        extractedFactModel.deleteMany({ tenantId: TENANT_ID }),
        conflictModel.deleteMany({ tenantId: TENANT_ID }),
        userModel.deleteMany({ tenantId: TENANT_ID }),
        sourceModel.deleteMany({ tenantId: TENANT_ID }),
      ]);
      await connection.close();
    }
  });

  it('reaches a terminal ingestionStatus for every fixture, via both a direct upload and an independent sync sweep', async () => {
    const documentStore = new FakeDocumentStore();
    const embeddingProvider = new FakeEmbeddingProvider(1024);
    const parserRegistry = new ParserRegistry(buildDocumentParsers());
    const logger = getMockLogger() as unknown as AppLogger;
    const auditService = { record: jest.fn() } as unknown as AuditService;
    const workflowEngine = new FakeWorkflowEngine();
    const config = getMockTypedConfig({
      sources: { inboxDir: FIXTURES, syncIntervalMs: 300_000 },
    });

    const documentsService = new DocumentsService(
      documentModel,
      documentVersionModel,
      evidenceChunkModel,
      extractedFactModel,
      conflictModel,
      userModel,
      documentStore,
      workflowEngine,
      auditService,
      logger,
      config,
    );
    const emailAttachmentService = new EmailAttachmentService(
      documentModel,
      documentsService,
      logger,
    );
    const ingestionService = new IngestionService(
      documentVersionModel,
      evidenceChunkModel,
      documentStore,
      embeddingProvider,
      parserRegistry,
      emailAttachmentService,
      connection,
      logger,
    );

    // `runSync`'s own lease/withdrawal work is unexercised by this test — only `create` is a
    // required constructor dependency, never called on this path.
    const workflowRunsService = { create: jest.fn() } as unknown as WorkflowRunsService;
    const sourceConnector = new LocalFolderSourceConnector(config);
    const sourcesService = new SourcesService(
      sourceModel,
      sourceConnector,
      workflowEngine,
      workflowRunsService,
      documentsService,
      config,
      auditService,
      logger,
    );

    // Rooted at the fixture tree itself (`config.sources.inboxDir` above); `path: '.'` walks every
    // fixture — including `duplicates/**` — the same way `syncOneFile` would for a real inbox
    // folder. `'.'`, not `''`: `Source.path` is `required: true`, and Mongoose's own required
    // validator treats an empty string as absent for a `String` field.
    const source = await sourceModel.create({
      name: `Adversarial sweep ${TENANT_ID}`,
      kind: 'local-folder',
      path: '.',
      tenantId: TENANT_ID,
    });

    const observations: FixtureOutcome[] = [];
    const ingestedByPath = new Map<
      string,
      {
        documentId: Types.ObjectId;
        versionId: Types.ObjectId;
        chunksCreated: number;
        alreadyIngested: boolean;
      }
    >();

    for (const file of manifest.files) {
      const content = await readFile(path.join(FIXTURES, file.path));

      let uploaded: UploadOutcome;
      try {
        uploaded = await documentsService.uploadVersion(
          {
            originalname: basename(file.path),
            mimetype: '',
            size: content.length,
            buffer: content,
          },
          {},
          TENANT_ID,
          { sourceClass: 'unclassified', sourceId: source._id, path: file.path },
        );
      } catch (error) {
        const name = error instanceof Error ? error.constructor.name : typeof error;
        observations.push({ path: file.path, outcome: 'gate-refused', detail: name });
        expect(GATE_REFUSED_EXCEPTIONS.get(file.path)).toBe(name);
        continue;
      }

      // A fixture on the gate-refused list that unexpectedly cleared the gate would otherwise
      // pass silently through the branch below.
      expect(GATE_REFUSED_EXCEPTIONS.has(file.path)).toBe(false);

      const ingestResult = await ingestionService
        .ingestVersion(uploaded.currentVersion._id.toString(), TENANT_ID)
        .catch(() => undefined);

      const version = await documentVersionModel.findById(uploaded.currentVersion._id);
      if (!version) {
        throw new Error(
          `Document version '${uploaded.currentVersion._id.toString()}' vanished after ingest`,
        );
      }

      observations.push({
        path: file.path,
        outcome: version.ingestionStatus,
        detail: version.ingestionFailureReason ?? '',
      });
      expect(expectedStatusesFor(file.path)).toContain(version.ingestionStatus);
      if (version.ingestionStatus === 'failed' || version.ingestionStatus === 'needs-ocr') {
        expect(version.ingestionFailureReason).toBeDefined();
      }

      ingestedByPath.set(file.path, {
        documentId: uploaded.document._id,
        versionId: version._id,
        chunksCreated: ingestResult?.chunksCreated ?? 0,
        alreadyIngested: ingestResult?.alreadyIngested ?? false,
      });
    }

    console.table(observations);

    // --- Dedupe: the byte-identical duplicate pair converges onto one Document/DocumentVersion. ---
    const folderA = ingestedByPath.get('duplicates/folder-a/rent-roll-summary.pdf');
    const folderB = ingestedByPath.get('duplicates/folder-b/rent-roll-summary.pdf');
    if (!folderA || !folderB) {
      throw new Error('The duplicate fixture pair did not both reach an ingested state');
    }
    expect(folderB.documentId.equals(folderA.documentId)).toBe(true);
    expect(folderB.versionId.equals(folderA.versionId)).toBe(true);
    expect(folderB.alreadyIngested).toBe(true);

    const duplicateDocument = await documentModel.findById(folderA.documentId);
    const duplicateLocationPaths = (duplicateDocument?.locations ?? []).map(
      (location) => location.path,
    );
    expect(duplicateLocationPaths).toEqual(
      expect.arrayContaining([
        'duplicates/folder-a/rent-roll-summary.pdf',
        'duplicates/folder-b/rent-roll-summary.pdf',
      ]),
    );

    const duplicateVersion = await documentVersionModel.findById(folderA.versionId);
    if (!duplicateVersion) {
      throw new Error('The duplicate fixture version vanished');
    }
    expect(
      await documentVersionModel.countDocuments({
        tenantId: TENANT_ID,
        sha256: duplicateVersion.sha256,
      }),
    ).toBe(1);
    expect(await evidenceChunkModel.countDocuments({ documentId: folderA.documentId })).toBe(
      folderA.chunksCreated,
    );

    // --- Sync-path visibility: an independent sweep reaches every manifest path too, and every
    // refused path is listed against the source rather than only logged. ---
    await sourcesService.runSync(source._id.toString(), new Types.ObjectId());
    const syncedSource = await sourceModel.findById(source._id);
    if (!syncedSource) {
      throw new Error('Source vanished after sync');
    }
    for (const file of manifest.files) {
      const fileState = syncedSource.fileStates.find((state) => state.path === file.path);
      expect(fileState).toBeDefined();
      if (GATE_REFUSED_EXCEPTIONS.has(file.path)) {
        expect(fileState?.lastError).toEqual(expect.any(String));
        expect(fileState?.documentId).toBeUndefined();
      } else {
        expect(fileState?.documentId).toBeDefined();
      }
    }

    // --- Nothing is left pending. ---
    expect(
      await documentVersionModel.countDocuments({
        tenantId: TENANT_ID,
        ingestionStatus: 'pending',
      }),
    ).toBe(0);
  }, 300_000);
});
