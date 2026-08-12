import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import {
  DocumentNotFoundException,
  DocumentVersionNotFoundException,
  MissingFileException,
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
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('DocumentsService', () => {
  let service: DocumentsService;

  const mockDocumentModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
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
        { provide: DOCUMENT_STORE, useValue: mockDocumentStore },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('upload — input gates', () => {
    it('should throw MissingFileException when no file is provided', async () => {
      await expect(service.upload(undefined, {})).rejects.toBeInstanceOf(MissingFileException);
    });

    it('should throw UnsupportedContentTypeException for a disallowed content type', async () => {
      const file = buildFile({ mimetype: 'text/csv' });

      await expect(service.upload(file, {})).rejects.toBeInstanceOf(
        UnsupportedContentTypeException,
      );
      expect(mockDocumentStore.put).not.toHaveBeenCalled();
    });
  });

  describe('upload — new document (no documentId)', () => {
    it('should throw BadRequestException when title is omitted', async () => {
      const file = buildFile();

      await expect(service.upload(file, {})).rejects.toBeInstanceOf(BadRequestException);
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

      await service.upload(file, { title: 'Q3 Rent Roll', requireApproval: true });

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith(
        'ingestDocumentVersion',
        expect.objectContaining({ requireApproval: true }),
      );
    });
  });

  describe('upload — new version (documentId present)', () => {
    it('should throw DocumentNotFoundException for a malformed documentId', async () => {
      const file = buildFile();

      await expect(service.upload(file, { documentId: 'not-an-object-id' })).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
    });

    it('should throw DocumentNotFoundException when the document does not exist', async () => {
      mockDocumentModel.findOne.mockResolvedValueOnce(null);
      const file = buildFile();

      await expect(
        service.upload(file, { documentId: documentId.toString() }),
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

      const result = await service.upload(file, { documentId: documentId.toString() });

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

      const result = await service.list({ skip: 0, limit: 20 });

      expect(mockDocumentModel.find).toHaveBeenCalledWith({ tenantId: 'default' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
        _id: { $in: [versionId] },
        tenantId: 'default',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].currentVersion.id).toBe(versionId.toString());
    });

    it('should scope the version lookup to the caller tenant, not the default', async () => {
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

      await expect(service.list({ skip: 0, limit: 20 })).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('getById', () => {
    it('should throw DocumentNotFoundException for a malformed id', async () => {
      await expect(service.getById('not-an-object-id')).rejects.toBeInstanceOf(
        DocumentNotFoundException,
      );
    });

    it('should throw DocumentNotFoundException when the document does not exist', async () => {
      mockDocumentModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getById(documentId.toString())).rejects.toBeInstanceOf(
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

      const result = await service.getById(documentId.toString());

      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
        documentId,
        tenantId: 'default',
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

      await expect(service.getById(documentId.toString())).rejects.toBeInstanceOf(
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
      await expect(service.getVersionContent('not-an-object-id', actorId)).rejects.toBeInstanceOf(
        DocumentVersionNotFoundException,
      );
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
});
