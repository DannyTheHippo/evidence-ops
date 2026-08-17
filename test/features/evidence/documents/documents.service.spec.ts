import type { MessageEvent } from '@nestjs/common';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  Conflict,
  MIN_CONFLICTING_FACTS,
} from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { DOCUMENTS_STREAM_INTERVAL_MS } from '../../../../src/features/evidence/documents/documents.constant';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import {
  DocumentNotFoundException,
  DocumentVersionNotFoundException,
  MissingFileException,
  UnresolvableContentTypeException,
  UnsupportedContentTypeException,
} from '../../../../src/features/evidence/documents/exceptions/documents.exception';
import type { UploadedFileLike } from '../../../../src/features/evidence/documents/types/uploaded-file.type';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../../src/providers/storage/document-store.interface';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
} from '../../../../src/shared/constants/sse.constant';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('DocumentsService', () => {
  let service: DocumentsService;

  const mockDocumentModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockEvidenceChunkModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockConflictModel = getMockModel();
  // `satisfies` rather than `: jest.Mocked<DocumentStore>`: the annotation types each property as
  // an interface *method*, so every `expect(mockDocumentStore.put)` reads as an unbound method
  // reference and trips `@typescript-eslint/unbound-method`. This keeps the constraint that the
  // keys match the interface while inferring the properties as plain `jest.Mock`.
  const mockDocumentStore = {
    put: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
  } satisfies Record<keyof DocumentStore, jest.Mock>;
  const mockWorkflowEngine = {
    start: jest.fn(),
    status: jest.fn(),
    signal: jest.fn(),
  } satisfies Record<keyof WorkflowEngine, jest.Mock>;
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const documentId = new Types.ObjectId();
  const versionId = new Types.ObjectId();
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const buildMockDocument = (overrides: Record<string, unknown> = {}) => ({
    _id: documentId,
    title: 'Q3 Rent Roll',
    sourceKind: 'xlsx',
    mimeType: XLSX_MIME,
    currentVersionId: versionId,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const buildMockVersion = (overrides: Record<string, unknown> = {}) => ({
    _id: versionId,
    documentId,
    versionNumber: 1,
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    storageKey: 'gridfs-id-1',
    ingestionStatus: 'pending',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  const buildFile = (overrides: Partial<UploadedFileLike> = {}): UploadedFileLike => ({
    originalname: 'comps.xlsx',
    mimetype: XLSX_MIME,
    size: 1024,
    buffer: Buffer.from('workbook-bytes'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(EvidenceChunk.name), useValue: mockEvidenceChunkModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: DOCUMENT_STORE, useValue: mockDocumentStore },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('upload — input gates', () => {
    it('should throw MissingFileException when no file is provided', async () => {
      await expect(service.upload(undefined, {}, 'tenant-a')).rejects.toBeInstanceOf(
        MissingFileException,
      );
    });

    it('should throw UnsupportedContentTypeException for a disallowed content type', async () => {
      const file = buildFile({ mimetype: 'image/png', originalname: 'comps.png' });

      await expect(service.upload(file, {}, 'tenant-a')).rejects.toBeInstanceOf(
        UnsupportedContentTypeException,
      );
      expect(mockDocumentStore.put).not.toHaveBeenCalled();
    });

    it('should throw UnresolvableContentTypeException — a 400, not a 415 — for an ambiguous MIME type with a disallowed extension: the browser-lied .xls case', async () => {
      const file = buildFile({ mimetype: 'application/vnd.ms-excel', originalname: 'legacy.xls' });

      await expect(service.upload(file, {}, 'tenant-a')).rejects.toBeInstanceOf(
        UnresolvableContentTypeException,
      );
      expect(mockDocumentStore.put).not.toHaveBeenCalled();
    });

    it('should throw UnresolvableContentTypeException for an ambiguous MIME type with no usable extension at all', async () => {
      const file = buildFile({ mimetype: 'application/octet-stream', originalname: 'archive.zip' });

      await expect(service.upload(file, {}, 'tenant-a')).rejects.toBeInstanceOf(
        UnresolvableContentTypeException,
      );
      expect(mockDocumentStore.put).not.toHaveBeenCalled();
    });
  });

  describe('upload — new document (no documentId)', () => {
    it('should title a new document from the uploaded filename when title is omitted', async () => {
      const file = buildFile();
      const mockDocument = buildMockDocument({ title: 'comps.xlsx' });
      mockDocumentModel.create.mockResolvedValueOnce(mockDocument);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-1',
        content: file.buffer,
        contentType: file.mimetype,
        metadata: {},
      });
      const expectedSha256 = createHash('sha256').update(file.buffer).digest('hex');
      const version = buildMockVersion({ versionNumber: 1, sha256: expectedSha256 });
      mockDocumentVersionModel.create.mockResolvedValueOnce(version);

      await service.upload(file, {}, 'tenant-a');

      expect(mockDocumentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'comps.xlsx' }),
      );
    });

    it('should throw BadRequestException when title and originalname are both empty', async () => {
      const file = buildFile({ originalname: '' });

      await expect(service.upload(file, {}, 'tenant-a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockDocumentModel.create).not.toHaveBeenCalled();
    });

    it('should create a document and its first version, and point currentVersionId at it', async () => {
      const file = buildFile();
      const mockDocument = buildMockDocument();
      mockDocumentModel.create.mockResolvedValueOnce(mockDocument);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-1',
        content: file.buffer,
        contentType: file.mimetype,
        metadata: {},
      });
      const expectedSha256 = createHash('sha256').update(file.buffer).digest('hex');
      // The stored version must carry the hash the service computed, so the fixture echoes it
      // back. Seeding the mock with a placeholder here would make the final assertion a test of
      // the fixture rather than of what the service returns.
      const version = buildMockVersion({ versionNumber: 1, sha256: expectedSha256 });
      mockDocumentVersionModel.create.mockResolvedValueOnce(version);

      const result = await service.upload(file, { title: 'Q3 Rent Roll' }, 'tenant-a');

      expect(mockDocumentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Q3 Rent Roll',
          sourceKind: 'xlsx',
          mimeType: XLSX_MIME,
          tenantId: 'tenant-a',
        }),
      );
      // GridFS is a driver-level bucket the tenant-scope plugin cannot reach — this metadata is
      // the defence-in-depth marker for the storage layer.
      expect(mockDocumentStore.put).toHaveBeenCalledWith({
        content: file.buffer,
        contentType: file.mimetype,
        metadata: { tenantId: 'tenant-a' },
      });
      expect(mockDocumentVersionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId,
          versionNumber: 1,
          sha256: expectedSha256,
          sizeBytes: file.size,
          storageKey: 'gridfs-id-1',
          tenantId: 'tenant-a',
        }),
      );
      expect(mockDocument.save).toHaveBeenCalled();
      expect(mockDocument.currentVersionId).toEqual(versionId);
      expect(result.currentVersion.versionNumber).toBe(1);
      expect(result.currentVersion.sha256).toBe(expectedSha256);
      // A new document always creates a new version, so ingestion must start for it — the whole
      // point of running it as a durable workflow is that this never blocks the upload response.
      // `requireApproval` is undefined here (the dto never set it) — the ungated default path.
      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('ingestDocumentVersion', {
        documentVersionId: versionId.toString(),
        requireApproval: undefined,
        documentTitle: 'Q3 Rent Roll',
        // The uploader's tenant, not the default: the gated ingest path resolves its approval row
        // through the now tenant-scoped `MongoApprovalChannel.getDecision`, which fails closed on a
        // mismatch — so a default here would deny every gated ingest for the wrong reason.
        tenantId: 'tenant-a',
      });
    });

    it('should store the resolved canonical MIME, not the browser-reported one, for an ambiguous upload', async () => {
      // Windows reports a .csv as this exact MIME — the load-bearing ambiguous case `resolveUploadKind`
      // exists for (see `documents.constant.ts`). The document row and the stored bytes must both
      // carry 'text/csv', never the raw 'application/vnd.ms-excel', or the parser registry's
      // exact-match lookup (`ParserRegistry.resolve`) would have to learn about the browser's lie too.
      const file = buildFile({
        mimetype: 'application/vnd.ms-excel',
        originalname: 'comps.csv',
        buffer: Buffer.from('csv-bytes'),
      });
      const mockDocument = buildMockDocument({ sourceKind: 'csv', mimeType: 'text/csv' });
      mockDocumentModel.create.mockResolvedValueOnce(mockDocument);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-csv',
        content: file.buffer,
        contentType: 'text/csv',
        metadata: {},
      });
      const version = buildMockVersion();
      mockDocumentVersionModel.create.mockResolvedValueOnce(version);

      await service.upload(file, { title: 'Comps CSV' }, 'tenant-a');

      expect(mockDocumentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKind: 'csv', mimeType: 'text/csv' }),
      );
      expect(mockDocumentStore.put).toHaveBeenCalledWith({
        content: file.buffer,
        contentType: 'text/csv',
        metadata: { tenantId: 'tenant-a' },
      });
    });

    it('should thread the caller-supplied sourceClass onto a newly created document', async () => {
      const file = buildFile();
      const mockDocument = buildMockDocument({ sourceClass: 'crm-export' });
      mockDocumentModel.create.mockResolvedValueOnce(mockDocument);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-1',
        content: file.buffer,
        contentType: file.mimetype,
        metadata: {},
      });
      const version = buildMockVersion();
      mockDocumentVersionModel.create.mockResolvedValueOnce(version);

      await service.upload(file, { title: 'Q3 Rent Roll' }, 'tenant-a', 'crm-export');

      expect(mockDocumentModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceClass: 'crm-export' }),
      );
    });

    it('should thread requireApproval through to the ingest workflow input when set on the upload dto', async () => {
      const file = buildFile();
      const mockDocument = buildMockDocument();
      mockDocumentModel.create.mockResolvedValueOnce(mockDocument);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-1',
        content: file.buffer,
        contentType: file.mimetype,
        metadata: {},
      });
      const version = buildMockVersion();
      mockDocumentVersionModel.create.mockResolvedValueOnce(version);

      await service.upload(file, { title: 'Q3 Rent Roll', requireApproval: true }, 'tenant-a');

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith(
        'ingestDocumentVersion',
        expect.objectContaining({ requireApproval: true }),
      );
    });
  });

  describe('upload — new version (documentId present)', () => {
    it('should throw DocumentNotFoundException for a malformed documentId', async () => {
      const file = buildFile();

      await expect(
        service.upload(file, { documentId: 'not-an-object-id' }, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentNotFoundException);
    });

    it('should throw DocumentNotFoundException when the document does not exist', async () => {
      mockDocumentModel.findOne.mockResolvedValueOnce(null);
      const file = buildFile();

      await expect(
        service.upload(file, { documentId: documentId.toString() }, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentNotFoundException);
    });

    it('should throw DocumentNotFoundException when the document belongs to another tenant — the cross-tenant attach this scoping closes', async () => {
      // The mock model does not filter by predicate — this asserts `addVersion` queries with the
      // caller's tenant predicate at all (so a wrong-tenant `documentId` can't be attached to),
      // not that a real Mongo would exclude the row.
      mockDocumentModel.findOne.mockResolvedValueOnce(null);
      const file = buildFile();

      await expect(
        service.upload(file, { documentId: documentId.toString() }, 'tenant-b'),
      ).rejects.toBeInstanceOf(DocumentNotFoundException);
      expect(mockDocumentModel.findOne).toHaveBeenCalledWith({
        _id: documentId.toString(),
        tenantId: 'tenant-b',
      });
      expect(mockDocumentStore.put).not.toHaveBeenCalled();
    });

    it('should not write a new version when the sha256 already exists for the document', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      const existingVersion = buildMockVersion();
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(existingVersion);
      const file = buildFile();

      const result = await service.upload(file, { documentId: documentId.toString() }, 'tenant-a');

      expect(mockDocumentStore.put).not.toHaveBeenCalled();
      expect(mockDocumentVersionModel.create).not.toHaveBeenCalled();
      expect(mockDocument.save).not.toHaveBeenCalled();
      expect(result.currentVersion.id).toBe(versionId.toString());
      // Content-addressed dedupe: no new bytes were stored, so there is nothing new to ingest.
      expect(mockWorkflowEngine.start).not.toHaveBeenCalled();
    });

    it('should create version 2 when the uploaded bytes are new for the document', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);
      mockDocumentVersionModel.countDocuments.mockResolvedValueOnce(1);
      mockDocumentStore.put.mockResolvedValueOnce({
        id: 'gridfs-id-2',
        content: Buffer.from('different-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      const newVersionId = new Types.ObjectId();
      const newVersion = buildMockVersion({ _id: newVersionId, versionNumber: 2 });
      mockDocumentVersionModel.create.mockResolvedValueOnce(newVersion);
      const file = buildFile({ buffer: Buffer.from('different-bytes') });

      const result = await service.upload(file, { documentId: documentId.toString() }, 'tenant-a');

      expect(mockDocumentVersionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId,
          versionNumber: 2,
          storageKey: 'gridfs-id-2',
          tenantId: 'tenant-a',
        }),
      );
      expect(mockDocumentStore.put).toHaveBeenCalledWith({
        content: file.buffer,
        contentType: file.mimetype,
        metadata: { tenantId: 'tenant-a' },
      });
      expect(mockDocument.save).toHaveBeenCalled();
      expect(mockDocument.currentVersionId).toEqual(newVersionId);
      expect(result.currentVersion.versionNumber).toBe(2);
      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('ingestDocumentVersion', {
        documentVersionId: newVersionId.toString(),
        requireApproval: undefined,
        documentTitle: 'Q3 Rent Roll',
        tenantId: 'tenant-a',
      });
    });
  });

  describe('list', () => {
    it('should return documents with their current version resolved via a batch lookup', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.find.mockResolvedValueOnce([mockDocument]);
      mockDocumentModel.countDocuments.mockResolvedValueOnce(1);
      const version = buildMockVersion();
      mockDocumentVersionModel.find.mockResolvedValueOnce([version]);

      const result = await service.list({ skip: 0, limit: 20 }, 'tenant-a');

      expect(mockDocumentModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
        _id: { $in: [versionId] },
        tenantId: 'tenant-a',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].currentVersion.id).toBe(versionId.toString());
    });

    it('should scope the version lookup to the caller tenant', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.find.mockResolvedValueOnce([mockDocument]);
      mockDocumentModel.countDocuments.mockResolvedValueOnce(1);
      const version = buildMockVersion();
      mockDocumentVersionModel.find.mockResolvedValueOnce([version]);

      await service.list({ skip: 0, limit: 20 }, 'tenant-b');

      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
        _id: { $in: [versionId] },
        tenantId: 'tenant-b',
      });
    });

    it('should throw when a document has no resolvable current version', async () => {
      const documentWithoutVersion = buildMockDocument({ currentVersionId: undefined });
      mockDocumentModel.find.mockResolvedValueOnce([documentWithoutVersion]);
      mockDocumentModel.countDocuments.mockResolvedValueOnce(1);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);

      await expect(service.list({ skip: 0, limit: 20 }, 'tenant-a')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('getById', () => {
    it('should throw DocumentNotFoundException for a malformed id', async () => {
      await expect(service.getById('not-an-object-id', 'tenant-a')).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
    });

    it('should throw DocumentNotFoundException when the document does not exist', async () => {
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getById(documentId.toString(), 'tenant-a')).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
    });

    it('should throw DocumentNotFoundException when the document belongs to another tenant', async () => {
      // The mock model does not filter by predicate — this asserts `getById` queries with the
      // tenant predicate at all, not that a real Mongo would exclude the row.
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getById(documentId.toString(), 'tenant-b')).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
      expect(mockDocumentModel.findOne).toHaveBeenCalledWith({
        _id: documentId.toString(),
        tenantId: 'tenant-b',
      });
    });

    it('should return the full version history with the current version identified', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      const v1 = buildMockVersion({ _id: new Types.ObjectId(), versionNumber: 1 });
      const v2 = buildMockVersion({ _id: versionId, versionNumber: 2 });
      mockDocumentVersionModel.find.mockReturnValueOnce({
        sort: jest.fn().mockResolvedValueOnce([v1, v2]),
      });

      const result = await service.getById(documentId.toString(), 'tenant-a');

      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
        documentId,
        tenantId: 'tenant-a',
      });
      expect(result.versions).toHaveLength(2);
      expect(result.currentVersion.id).toBe(versionId.toString());
      expect(result.currentVersion.versionNumber).toBe(2);
    });

    it('should throw when the current version id matches none of the fetched versions', async () => {
      const mockDocument = buildMockDocument({ currentVersionId: undefined });
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.find.mockReturnValueOnce({
        sort: jest.fn().mockResolvedValueOnce([buildMockVersion()]),
      });

      await expect(service.getById(documentId.toString(), 'tenant-a')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('getVersionContent', () => {
    const actorId = new Types.ObjectId().toString();
    const storedContent = {
      id: 'gridfs-id-1',
      content: Buffer.from('workbook-bytes'),
      contentType: XLSX_MIME,
      metadata: { tenantId: 'tenant-a' },
    };

    it('should throw DocumentVersionNotFoundException for a malformed versionId', async () => {
      await expect(
        service.getVersionContent('not-an-object-id', actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockDocumentVersionModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw DocumentVersionNotFoundException when the version does not exist', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getVersionContent(versionId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockDocumentVersionModel.findOne).toHaveBeenCalledWith({
        _id: versionId.toString(),
        tenantId: 'tenant-a',
      });
      expect(mockDocumentStore.get).not.toHaveBeenCalled();
    });

    it('should throw DocumentVersionNotFoundException when the version belongs to another tenant — the cross-tenant lookup this scoping closes', async () => {
      // The mock model does not filter by predicate — this asserts the tenant predicate is on
      // the query at all, not that a real Mongo would exclude the row.
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getVersionContent(versionId.toString(), actorId, 'tenant-b'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
    });

    it('should throw DocumentVersionNotFoundException when the parent document cannot be resolved for this tenant', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getVersionContent(versionId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockDocumentStore.get).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when the version row has no stored bytes — corruption, not a client error', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(buildMockDocument());
      mockDocumentStore.get.mockResolvedValueOnce(null);

      await expect(
        service.getVersionContent(versionId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should throw DocumentVersionNotFoundException — fail CLOSED, indistinguishable from not-found — when the GridFS tenantId stamp is present but mismatched', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(buildMockDocument());
      mockDocumentStore.get.mockResolvedValueOnce({
        ...storedContent,
        metadata: { tenantId: 'tenant-b' },
      });

      await expect(
        service.getVersionContent(versionId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should serve and warn — fail OPEN — when the GridFS tenantId stamp is absent (a pre-stamp legacy object)', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(buildMockDocument());
      mockDocumentStore.get.mockResolvedValueOnce({ ...storedContent, metadata: {} });

      const result = await service.getVersionContent(versionId.toString(), actorId, 'tenant-a');

      expect(result.content).toBe(storedContent.content);
      expect(mockAuditService.record).toHaveBeenCalled();
    });

    it('should return the stored bytes, content type, and a sanitized filename, and record an audit row', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(buildMockDocument());
      mockDocumentStore.get.mockResolvedValueOnce(storedContent);

      const result = await service.getVersionContent(versionId.toString(), actorId, 'tenant-a');

      expect(mockDocumentStore.get).toHaveBeenCalledWith('gridfs-id-1');
      expect(result).toEqual({
        content: storedContent.content,
        contentType: XLSX_MIME,
        filename: 'Q3_Rent_Roll-v1.xlsx',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'documents.version.downloaded',
        actorId,
        subject: { entityType: 'DocumentVersion', entityId: versionId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should derive an unrecognised stored content type to a "bin" extension rather than throwing', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockDocumentModel.findOne.mockResolvedValueOnce(buildMockDocument());
      mockDocumentStore.get.mockResolvedValueOnce({
        ...storedContent,
        contentType: 'application/octet-stream',
      });

      const result = await service.getVersionContent(versionId.toString(), actorId, 'tenant-a');

      expect(result.filename).toBe('Q3_Rent_Roll-v1.bin');
    });
  });

  describe('listVersionChunks', () => {
    const actorId = new Types.ObjectId().toString();

    const buildMockChunk = (overrides: Record<string, unknown> = {}) => ({
      _id: 'chunk-1',
      documentId,
      documentVersionId: versionId,
      text: 'chunk text',
      tokenCount: 128,
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      tenantId: 'tenant-a',
      ...overrides,
    });

    it('should throw DocumentVersionNotFoundException for a malformed versionId', async () => {
      await expect(
        service.listVersionChunks('not-an-object-id', actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockDocumentVersionModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw DocumentVersionNotFoundException when the version does not exist', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.listVersionChunks(versionId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockDocumentVersionModel.findOne).toHaveBeenCalledWith({
        _id: versionId.toString(),
        tenantId: 'tenant-a',
      });
      expect(mockEvidenceChunkModel.find).not.toHaveBeenCalled();
    });

    it('should throw DocumentVersionNotFoundException when the version belongs to another tenant — the cross-tenant lookup this scoping closes', async () => {
      // The mock model does not filter by predicate — this asserts the tenant predicate is on
      // the query at all, not that a real Mongo would exclude the row.
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.listVersionChunks(versionId.toString(), actorId, 'tenant-b'),
      ).rejects.toBeInstanceOf(DocumentVersionNotFoundException);
      expect(mockEvidenceChunkModel.find).not.toHaveBeenCalled();
    });

    it('should return an empty docs array with a zero count when the version has no chunks', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      mockEvidenceChunkModel.find.mockResolvedValueOnce([]);

      const result = await service.listVersionChunks(versionId.toString(), actorId, 'tenant-a');

      expect(result).toEqual({ docs: [], count: 0 });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'documents.version.chunks.listed',
        actorId,
        subject: { entityType: 'DocumentVersion', entityId: versionId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should query with embedding excluded by projection, and sort every locator kind application-side', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildMockVersion());
      const docChunk = buildMockChunk({
        _id: 'chunk-docx',
        locator: {
          kind: 'docx-paragraph',
          extractorVersion: 'v1',
          paragraphIndex: 5,
          headingPath: [],
        },
      });
      const pdfChunkPage10 = buildMockChunk({
        _id: 'chunk-pdf-10',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 10 },
      });
      const pdfChunkPage2 = buildMockChunk({
        _id: 'chunk-pdf-2',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
      const xlsxCellChunk = buildMockChunk({
        _id: 'chunk-xlsx-cell',
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'C3' },
      });
      const xlsxRegionChunk = buildMockChunk({
        _id: 'chunk-xlsx-region',
        locator: {
          kind: 'xlsx-region',
          extractorVersion: 'v1',
          sheetName: 'Comps',
          range: 'A1:B2',
        },
      });
      const textBlockChunk = buildMockChunk({
        _id: 'chunk-text-block',
        locator: { kind: 'text-block', extractorVersion: 'v1', blockIndex: 3, headingPath: [] },
      });
      const pptxSlideChunk = buildMockChunk({
        _id: 'chunk-pptx-slide',
        locator: { kind: 'pptx-slide', extractorVersion: 'v1', slide: 4 },
      });
      // Deliberately scrambled, and deliberately unsorted within the pdf-page pair (10 before 2) —
      // a naive string sort on the raw page number would place '10' before '2'.
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        xlsxRegionChunk,
        pdfChunkPage10,
        textBlockChunk,
        docChunk,
        xlsxCellChunk,
        pptxSlideChunk,
        pdfChunkPage2,
      ]);

      const result = await service.listVersionChunks(versionId.toString(), actorId, 'tenant-a');

      expect(mockEvidenceChunkModel.find).toHaveBeenCalledWith(
        { documentVersionId: versionId, tenantId: 'tenant-a' },
        { embedding: 0 },
      );
      expect(result.count).toBe(7);
      expect(result.docs.map((doc) => doc.id)).toEqual([
        'chunk-docx',
        'chunk-pdf-2',
        'chunk-pdf-10',
        'chunk-pptx-slide',
        'chunk-text-block',
        'chunk-xlsx-cell',
        'chunk-xlsx-region',
      ]);
      expect(result.docs[0]).toEqual({
        id: 'chunk-docx',
        text: 'chunk text',
        tokenCount: 128,
        locator: {
          kind: 'docx-paragraph',
          extractorVersion: 'v1',
          paragraphIndex: 5,
          headingPath: [],
        },
      });
    });
  });

  describe('remove', () => {
    const actorId = new Types.ObjectId().toString();

    it('should throw DocumentNotFoundException for a malformed id', async () => {
      await expect(service.remove('not-an-object-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
      expect(mockDocumentModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw DocumentNotFoundException when the document does not exist', async () => {
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.remove(documentId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(DocumentNotFoundException);
      expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    });

    it('should throw DocumentNotFoundException when the document belongs to another tenant — the cross-tenant lookup this scoping closes', async () => {
      // The mock model does not filter by predicate — this asserts `remove` queries with the
      // caller's tenant predicate at all, not that a real Mongo would exclude the row.
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.remove(documentId.toString(), actorId, 'tenant-b'),
      ).rejects.toBeInstanceOf(DocumentNotFoundException);
      expect(mockDocumentModel.findOne).toHaveBeenCalledWith({
        _id: documentId.toString(),
        tenantId: 'tenant-b',
      });
    });

    it('should cascade-delete a document with no versions, skipping GridFS deletes and conflict resolution', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.find.mockResolvedValueOnce([]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service.remove(documentId.toString(), actorId, 'tenant-a');

      expect(mockConflictModel.updateMany).not.toHaveBeenCalled();
      // Twice each — the first pass, and the post-version-deletion sweep (see the "re-runs the
      // fact and chunk deletes" test below for what the sweep itself is for).
      expect(mockExtractedFactModel.deleteMany).toHaveBeenCalledTimes(2);
      expect(mockExtractedFactModel.deleteMany).toHaveBeenNthCalledWith(1, {
        documentVersionId: { $in: [] },
        tenantId: 'tenant-a',
      });
      expect(mockExtractedFactModel.deleteMany).toHaveBeenNthCalledWith(2, {
        documentVersionId: { $in: [] },
        tenantId: 'tenant-a',
      });
      expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledTimes(2);
      expect(mockEvidenceChunkModel.deleteMany).toHaveBeenNthCalledWith(1, {
        documentId,
        tenantId: 'tenant-a',
      });
      expect(mockEvidenceChunkModel.deleteMany).toHaveBeenNthCalledWith(2, {
        documentId,
        tenantId: 'tenant-a',
      });
      expect(mockDocumentStore.delete).not.toHaveBeenCalled();
      expect(mockDocumentVersionModel.deleteMany).toHaveBeenCalledWith({
        documentId,
        tenantId: 'tenant-a',
      });
      expect(mockDocumentModel.deleteOne).toHaveBeenCalledWith({
        _id: documentId,
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'documents.deleted',
        actorId,
        subject: { entityType: 'Document', entityId: documentId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should re-run the fact and chunk deletes after the version rows are gone — a deliberate sweep against a concurrent ingest, not accidental duplication', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.find.mockResolvedValueOnce([buildMockVersion()]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const callOrder: string[] = [];
      mockExtractedFactModel.deleteMany.mockImplementation(() => {
        callOrder.push('facts');
        return Promise.resolve(undefined);
      });
      mockEvidenceChunkModel.deleteMany.mockImplementation(() => {
        callOrder.push('chunks');
        return Promise.resolve(undefined);
      });
      mockDocumentVersionModel.deleteMany.mockImplementation(() => {
        callOrder.push('versions');
        return Promise.resolve(undefined);
      });

      await service.remove(documentId.toString(), actorId, 'tenant-a');

      // First pass runs before the version rows are deleted, the sweep runs after — a race that
      // inserts new chunks/facts between the two only ever lands inside the sweep's window.
      expect(callOrder).toEqual(['facts', 'chunks', 'versions', 'facts', 'chunks']);
    });

    it('should delete the stored GridFS bytes for every version in the cascade', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      const versionA = buildMockVersion({ _id: new Types.ObjectId(), storageKey: 'gridfs-id-a' });
      const versionB = buildMockVersion({ _id: new Types.ObjectId(), storageKey: 'gridfs-id-b' });
      mockDocumentVersionModel.find.mockResolvedValueOnce([versionA, versionB]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service.remove(documentId.toString(), actorId, 'tenant-a');

      expect(mockDocumentStore.delete).toHaveBeenCalledTimes(2);
      expect(mockDocumentStore.delete).toHaveBeenNthCalledWith(1, 'gridfs-id-a');
      expect(mockDocumentStore.delete).toHaveBeenNthCalledWith(2, 'gridfs-id-b');
    });

    it("should $pull the deleted fact ids out of every open conflict's factIds, then resolve as 'superseded' only what that pull left short of MIN_CONFLICTING_FACTS", async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.find.mockResolvedValueOnce([buildMockVersion()]);
      const factId = new Types.ObjectId();
      mockExtractedFactModel.find.mockResolvedValueOnce([{ _id: factId }]);

      await service.remove(documentId.toString(), actorId, 'tenant-a');

      expect(mockConflictModel.updateMany).toHaveBeenCalledTimes(2);

      // Call 1: pulls this document's fact ids out of every open conflict that referenced one —
      // rides the `{tenantId, status, factIds}` compound index from migration 0006.
      const [pullFilter, pullUpdate, pullOptions] = (
        mockConflictModel.updateMany as jest.Mock<
          Promise<unknown>,
          [Record<string, unknown>, unknown, Record<string, unknown> | undefined]
        >
      ).mock.calls[0];
      expect(pullFilter).toEqual({
        tenantId: 'tenant-a',
        status: 'open',
        factIds: { $in: [factId] },
      });
      expect(pullUpdate).toEqual([
        { $set: { factIds: { $setDifference: ['$factIds', [factId]] } } },
      ]);
      // Asserted because a mocked model cannot: Mongoose 9 rejects an array update without
      // `updatePipeline`, so omitting it 500s the real DELETE endpoint while every unit test here
      // still passes. Caught by e2e once; pinned here so it cannot regress silently again.
      expect(pullOptions).toEqual({ updatePipeline: true });

      // Call 2: only a conflict the pull left with fewer than `MIN_CONFLICTING_FACTS` references
      // is resolved-as-superseded — a conflict left with two or more surviving facts still matches
      // `status: 'open'` and is untouched by this call's `$expr` predicate.
      // Recast rather than `expect.any(Date)` inside an object literal — its `any`-typed return
      // trips `no-unsafe-assignment`, same reasoning `ingestion.service.spec.ts`'s
      // `getFindOneAndUpdateCall` documents for its own identical case.
      const [flipFilter, flipUpdate] = (
        mockConflictModel.updateMany as jest.Mock<
          Promise<unknown>,
          [Record<string, unknown>, { status: string; resolution: Record<string, unknown> }]
        >
      ).mock.calls[1];
      expect(flipFilter).toEqual({
        tenantId: 'tenant-a',
        status: 'open',
        $expr: { $lt: [{ $size: '$factIds' }, MIN_CONFLICTING_FACTS] },
      });
      expect(flipUpdate.status).toBe('resolved');
      expect(flipUpdate.resolution.outcome).toBe('superseded');
      expect(flipUpdate.resolution.resolvedAt).toBeInstanceOf(Date);
    });

    it('should skip conflict resolution when the document has no extracted facts', async () => {
      const mockDocument = buildMockDocument();
      mockDocumentModel.findOne.mockResolvedValueOnce(mockDocument);
      mockDocumentVersionModel.find.mockResolvedValueOnce([buildMockVersion()]);
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service.remove(documentId.toString(), actorId, 'tenant-a');

      expect(mockConflictModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('streamList', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // `list()` resolves its docs' `currentVersion` via a second query — every tick needs both
    // mocks primed, unlike the single-model peeks `qa`/`workflow-runs` stream from.
    const primeOneDocumentTick = () => {
      mockDocumentModel.find.mockResolvedValueOnce([buildMockDocument()]);
      mockDocumentModel.countDocuments.mockResolvedValueOnce(1);
      mockDocumentVersionModel.find.mockResolvedValueOnce([buildMockVersion()]);
    };

    it('should emit the first documents event immediately, recording no audit row', async () => {
      primeOneDocumentTick();
      const events: MessageEvent[] = [];

      const subscription = service.streamList('tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(events).toEqual([
        {
          type: 'documents',
          data: {
            docs: [expect.objectContaining({ id: documentId.toString() })],
            count: 1,
          },
        },
      ]);
      expect(mockDocumentModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditService.record).not.toHaveBeenCalled();

      subscription.unsubscribe();
    });

    it('should not re-emit an unchanged document list on the next tick', async () => {
      primeOneDocumentTick();
      primeOneDocumentTick();
      const events: MessageEvent[] = [];

      const subscription = service.streamList('tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      const countAfterFirstTick = events.length;

      await jest.advanceTimersByTimeAsync(DOCUMENTS_STREAM_INTERVAL_MS);

      expect(events).toHaveLength(countAfterFirstTick);
      subscription.unsubscribe();
    });

    it('should emit a heartbeat event on its own 15s interval', async () => {
      // Every tick between t=0 and the 15s heartbeat needs a resolved read (documents$ ticks
      // every 3s) — `mockResolvedValue`, not `Once`, so a tick past the first one doesn't hit an
      // unmocked call and error the whole merged stream out before the heartbeat ever fires.
      mockDocumentModel.find.mockResolvedValue([buildMockDocument()]);
      mockDocumentModel.countDocuments.mockResolvedValue(1);
      mockDocumentVersionModel.find.mockResolvedValue([buildMockVersion()]);
      const events: MessageEvent[] = [];

      const subscription = service.streamList('tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS);

      expect(events.some((event) => event.type === 'heartbeat')).toBe(true);
      subscription.unsubscribe();
    });

    it('should emit a terminal error event carrying a fixed client-facing message, never the raw driver error, and log the real error server-side', async () => {
      mockDocumentModel.find.mockRejectedValueOnce(new Error('mongo unreachable'));
      const events: MessageEvent[] = [];
      let completed = false;

      service.streamList('tenant-a').subscribe({
        next: (event) => events.push(event),
        complete: () => {
          completed = true;
        },
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(completed).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe(SSE_STREAM_ERROR_MESSAGE);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('mongo unreachable'));
    });

    it('should stringify a non-Error rejection rather than reading a `.message` that does not exist', async () => {
      // rxjs/Mongoose never guarantee the rejection is an `Error` instance — this covers the
      // `String(error)` branch of `error instanceof Error ? error.message : String(error)`.
      mockDocumentModel.find.mockRejectedValueOnce('a plain string rejection');
      const events: MessageEvent[] = [];

      service.streamList('tenant-a').subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);

      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe(SSE_STREAM_ERROR_MESSAGE);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('a plain string rejection'),
      );
    });
  });
});
