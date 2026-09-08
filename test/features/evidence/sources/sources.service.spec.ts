import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { DEFAULT_TENANT_ID } from '../../../../src/database/constants/tenant.constant';
import {
  Source,
  type SourceFileState,
} from '../../../../src/database/schemas/evidence/source/source.schema';
import { MAX_FILE_SIZE_BYTES } from '../../../../src/features/evidence/documents/documents.constant';
import { DocumentsService } from '../../../../src/features/evidence/documents/documents.service';
import {
  SourceNameConflictException,
  SourceNotFoundException,
} from '../../../../src/features/evidence/sources/exceptions/sources.exception';
import { SourcesService } from '../../../../src/features/evidence/sources/sources.service';
import { WorkflowRunsService } from '../../../../src/features/evidence/workflow-runs/workflow-runs.service';
import {
  SOURCE_CONNECTOR,
  type SourceConnector,
} from '../../../../src/providers/source-connector/source-connector.interface';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../../src/providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

/** Shape of `SourcesService.finalizeSync`'s Mongoose update argument — declared here so extracting
 *  it from a mocked `findOneAndUpdate` call is a single typed cast rather than an unsafe `any`
 *  chain (`getMockModel`'s `jest.Mock` carries no argument types to infer from). */
interface FinalizeUpdatePayload {
  $set: {
    fileStates: SourceFileState[];
    lastSyncAt: Date;
    lastSyncStatus: string;
    lastSyncError?: string;
    lastWithdrawalSuppressedAt?: Date;
    lastWithdrawalSuppressedReason?: string;
  };
  $unset?: { lastSyncError: string };
}

describe('SourcesService', () => {
  let service: SourcesService;

  const mockSourceModel = getMockModel();
  const mockSourceConnector = {
    listFiles: jest.fn(),
    fetchFile: jest.fn(),
  } satisfies Record<keyof SourceConnector, jest.Mock>;
  const mockWorkflowEngine = {
    start: jest.fn(),
    status: jest.fn(),
    signal: jest.fn(),
  } satisfies Record<keyof WorkflowEngine, jest.Mock>;
  const mockWorkflowRunsService = { create: jest.fn(), findRunByWorkflowId: jest.fn() };
  const mockDocumentsService = {
    upload: jest.fn(),
    countBySourceAndClass: jest.fn(),
    applySourceClassToDrifted: jest.fn(),
    withdrawVersions: jest.fn(),
    reinstateVersions: jest.fn(),
    recordLocation: jest.fn(),
    forgetLocation: jest.fn(),
  };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const sourceId = new Types.ObjectId();
  const documentIdA = new Types.ObjectId();
  const documentIdB = new Types.ObjectId();
  const actorId = new Types.ObjectId().toString();

  const buildMockSource = (overrides: Record<string, unknown> = {}) => ({
    _id: sourceId,
    name: 'Deal Room Inbox',
    kind: 'local-folder',
    path: 'deal-room',
    enabled: true,
    intervalMs: undefined,
    syncWorkflowId: undefined,
    syncLeaseToken: undefined,
    lastSyncAt: undefined,
    lastSyncStatus: undefined,
    lastSyncError: undefined,
    fileStates: [],
    tenantId: DEFAULT_TENANT_ID,
    connectivity: 'connector',
    reachability: 'live',
    owner: undefined,
    tracked: true,
    sourceClass: 'unclassified',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  /**
   * Builds a `fileStates` entry shaped like a real Mongoose embedded subdocument rather than a
   * plain object literal: every field lives on the returned object's PROTOTYPE as a getter, not as
   * an own enumerable property, exactly like `SourceFileStateSchema`'s compiled subdocuments do at
   * runtime. `getMockModel`'s `findOneAndUpdate` is a bare `jest.fn()` that hands back whatever a
   * test resolves it to, so every other `fileStates` fixture here is a plain literal — spreading a
   * plain literal (`{ ...state }`) copies every field, silently passing even where
   * `SourcesService.cloneFileState`'s real target (a subdocument) would have every field but the
   * override dropped. A test that must catch a regression back to `{ ...state }` needs a fixture
   * this shape reproduces the drop on; `state.path` etc. still read correctly through the
   * prototype, matching how the production code accesses the real subdocument.
   */
  const asSubdocumentLikeFileState = (state: SourceFileState): SourceFileState => {
    const proto: SourceFileState = {
      path: state.path,
      sha256: state.sha256,
      sizeBytes: state.sizeBytes,
      mtimeMs: state.mtimeMs,
      documentId: state.documentId,
      lastError: state.lastError,
      absentSweeps: state.absentSweeps,
      withdrawnAt: state.withdrawnAt,
    };
    return Object.create(proto) as SourceFileState;
  };

  /** Extracts the update document from the Nth `findOneAndUpdate` call (0-indexed) — every
   *  `runSync` test that inspects what `finalizeSync` persisted reads through this rather than
   *  indexing `mock.calls` directly. */
  const getFinalizeUpdate = (callIndex: number): FinalizeUpdatePayload => {
    const [, update] = mockSourceModel.findOneAndUpdate.mock.calls[callIndex] as [
      unknown,
      FinalizeUpdatePayload,
    ];
    return update;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SourcesService,
        { provide: getModelToken(Source.name), useValue: mockSourceModel },
        { provide: SOURCE_CONNECTOR, useValue: mockSourceConnector },
        { provide: WORKFLOW_ENGINE, useValue: mockWorkflowEngine },
        { provide: WorkflowRunsService, useValue: mockWorkflowRunsService },
        { provide: DocumentsService, useValue: mockDocumentsService },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<SourcesService>(SourcesService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('create', () => {
    it('should create a source with the provided tenant, owner, and default the rest', async () => {
      const created = buildMockSource();
      mockSourceModel.create.mockResolvedValueOnce(created);

      const result = await service.create({
        name: 'Deal Room Inbox',
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'Jane Doe, IT',
        actorId,
        tenantId: 'tenant-a',
      });

      expect(mockSourceModel.create).toHaveBeenCalledWith({
        name: 'Deal Room Inbox',
        kind: 'local-folder',
        path: 'deal-room',
        enabled: true,
        intervalMs: undefined,
        connectivity: 'connector',
        reachability: 'live',
        owner: 'Jane Doe, IT',
        tracked: true,
        sourceClass: 'unclassified',
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.created',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result.id).toBe(sourceId.toString());
    });

    it('should respect an explicit enabled/intervalMs/connectivity/reachability/tracked/sourceClass override', async () => {
      mockSourceModel.create.mockResolvedValueOnce(buildMockSource());

      await service.create({
        name: 'Deal Room Inbox',
        kind: 'local-folder',
        path: 'deal-room',
        enabled: false,
        intervalMs: 60000,
        connectivity: 'export-only',
        reachability: 'possible',
        owner: 'Jane Doe, IT',
        tracked: false,
        sourceClass: 'crm-export',
        actorId,
        tenantId: 'tenant-b',
      });

      expect(mockSourceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          intervalMs: 60000,
          connectivity: 'export-only',
          reachability: 'possible',
          tracked: false,
          sourceClass: 'crm-export',
          tenantId: 'tenant-b',
        }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-b' }),
      );
    });

    it('should map a duplicate-name E11000 error to SourceNameConflictException', async () => {
      mockSourceModel.create.mockRejectedValueOnce({ code: 11000 });

      await expect(
        service.create({
          name: 'Deal Room Inbox',
          kind: 'local-folder',
          path: 'deal-room',
          owner: 'Jane Doe, IT',
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBeInstanceOf(SourceNameConflictException);
    });

    it('should rethrow a non-duplicate object error unchanged', async () => {
      const error = { code: 500, message: 'boom' };
      mockSourceModel.create.mockRejectedValueOnce(error);

      await expect(
        service.create({
          name: 'Deal Room Inbox',
          kind: 'local-folder',
          path: 'deal-room',
          owner: 'Jane Doe, IT',
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBe(error);
    });

    it('should rethrow a plain Error unchanged (no code property at all)', async () => {
      const error = new Error('boom');
      mockSourceModel.create.mockRejectedValueOnce(error);

      await expect(
        service.create({
          name: 'Deal Room Inbox',
          kind: 'local-folder',
          path: 'deal-room',
          owner: 'Jane Doe, IT',
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBe(error);
    });

    it('should rethrow a non-object thrown value unchanged', async () => {
      mockSourceModel.create.mockRejectedValueOnce('boom');

      await expect(
        service.create({
          name: 'Deal Room Inbox',
          kind: 'local-folder',
          path: 'deal-room',
          owner: 'Jane Doe, IT',
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBe('boom');
    });

    it('should rethrow a null thrown value unchanged', async () => {
      mockSourceModel.create.mockRejectedValueOnce(null);

      await expect(
        service.create({
          name: 'Deal Room Inbox',
          kind: 'local-folder',
          path: 'deal-room',
          owner: 'Jane Doe, IT',
          actorId,
          tenantId: 'tenant-a',
        }),
      ).rejects.toBe(null);
    });
  });

  describe('list', () => {
    it('should list sources for a tenant with count and record an audit event', async () => {
      mockSourceModel.find.mockResolvedValueOnce([buildMockSource()]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockSourceModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result.count).toBe(1);
      expect(result.docs).toHaveLength(1);
    });

    it('should filter by lastSyncStatus when provided', async () => {
      mockSourceModel.find.mockResolvedValueOnce([buildMockSource({ lastSyncStatus: 'failed' })]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(1);

      await service.list({ skip: 0, limit: 20, lastSyncStatus: 'failed' }, actorId, 'tenant-a');

      expect(mockSourceModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', lastSyncStatus: 'failed' },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
    });

    it('should filter by tracked when provided, including an explicit false', async () => {
      mockSourceModel.find.mockResolvedValueOnce([buildMockSource({ tracked: false })]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(1);

      await service.list({ skip: 0, limit: 20, tracked: false }, actorId, 'tenant-a');

      expect(mockSourceModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', tracked: false },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
    });

    it('should filter by a case-insensitive q across name, path and owner when provided', async () => {
      mockSourceModel.find.mockResolvedValueOnce([buildMockSource()]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(1);

      await service.list({ skip: 0, limit: 20, q: 'Deal Room' }, actorId, 'tenant-a');

      const pattern = /Deal Room/i;
      expect(mockSourceModel.find).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-a',
          $or: [{ name: pattern }, { path: pattern }, { owner: pattern }],
        },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
    });

    it('should escape a regex-special character in q so it is treated as a literal', async () => {
      mockSourceModel.find.mockResolvedValueOnce([]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(0);

      await service.list({ skip: 0, limit: 20, q: 'a.b(c)' }, actorId, 'tenant-a');

      const pattern = /a\.b\(c\)/i;
      expect(mockSourceModel.find).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-a',
          $or: [{ name: pattern }, { path: pattern }, { owner: pattern }],
        },
        null,
        expect.objectContaining({ skip: 0, limit: 20 }),
      );
    });

    it.each([
      ['createdAt', 'desc', { createdAt: -1 }],
      ['owner', 'asc', { owner: 1 }],
      ['lastSyncAt', 'desc', { lastSyncAt: -1 }],
    ] as const)(
      'should sort by the caller-supplied %s field and %s direction',
      async (sort, sortDir, expectedSort) => {
        mockSourceModel.find.mockResolvedValueOnce([]);
        mockSourceModel.countDocuments.mockResolvedValueOnce(0);

        await service.list({ skip: 0, limit: 20, sort, sortDir }, actorId, 'tenant-a');

        expect(mockSourceModel.find).toHaveBeenCalledWith(
          { tenantId: 'tenant-a' },
          null,
          expect.objectContaining({ sort: expectedSort }),
        );
      },
    );

    it('should default to sorting by name ascending when no sort is given', async () => {
      mockSourceModel.find.mockResolvedValueOnce([]);
      mockSourceModel.countDocuments.mockResolvedValueOnce(0);

      await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockSourceModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        null,
        expect.objectContaining({ sort: { name: 1 } }),
      );
    });
  });

  describe('getById', () => {
    it('should throw SourceNotFoundException for a malformed id', async () => {
      await expect(service.getById('not-an-id', actorId, 'tenant-a')).rejects.toBeInstanceOf(
        SourceNotFoundException,
      );
      expect(mockSourceModel.findOne).not.toHaveBeenCalled();
    });

    it('should throw SourceNotFoundException when no source matches the tenant', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getById(sourceId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
    });

    it('should return the source and record an audit event when found', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource());

      const result = await service.getById(sourceId.toString(), actorId, 'tenant-a');

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.viewed',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result.name).toBe('Deal Room Inbox');
    });

    it('should derive a per-file status from whether lastError is set', async () => {
      const okState: SourceFileState = {
        path: 'contracts/lease.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        mtimeMs: 1_753_920_000_000,
        documentId: documentIdA,
      };
      const failedState: SourceFileState = {
        path: 'contracts/broken.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 2048,
        mtimeMs: 1_753_920_100_000,
        documentId: documentIdB,
        lastError: "Could not resolve a document type for 'contracts/broken.pdf'",
      };
      mockSourceModel.findOne.mockResolvedValueOnce(
        buildMockSource({ fileStates: [okState, failedState] }),
      );

      const result = await service.getById(sourceId.toString(), actorId, 'tenant-a');

      expect(result.fileStates).toEqual([
        { path: okState.path, status: 'ok', lastError: undefined, mtimeMs: okState.mtimeMs },
        {
          path: failedState.path,
          status: 'failed',
          lastError: failedState.lastError,
          mtimeMs: failedState.mtimeMs,
        },
      ]);
    });
  });

  describe('update', () => {
    it('should throw SourceNotFoundException for a malformed id', async () => {
      await expect(
        service.update('not-an-id', { enabled: false }, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
      expect(mockSourceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw SourceNotFoundException when no source matches the tenant', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update(sourceId.toString(), { enabled: false }, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
      expect(mockSourceModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw SourceNotFoundException when the source is deleted between the read and the update', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource());
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.update(sourceId.toString(), { enabled: false }, actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should $set only the enabled field when it is the only one provided, and touch neither sourceClass nor previousSourceClass', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource());
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(buildMockSource({ enabled: false }));

      const result = await service.update(
        sourceId.toString(),
        { enabled: false },
        actorId,
        'tenant-a',
      );

      expect(mockSourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: sourceId.toString(), tenantId: 'tenant-a' },
        { $set: { enabled: false } },
        { new: true },
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.updated',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result.enabled).toBe(false);
    });

    it('should $set every inventory field, including a falsy tracked, when all are provided, and stamp previousSourceClass on the actual sourceClass change', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource());
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockSource({
          connectivity: 'export-only',
          reachability: 'possible',
          owner: 'Jane Doe, IT',
          tracked: false,
          sourceClass: 'crm-export',
          previousSourceClass: 'unclassified',
        }),
      );

      const result = await service.update(
        sourceId.toString(),
        {
          connectivity: 'export-only',
          reachability: 'possible',
          owner: 'Jane Doe, IT',
          tracked: false,
          sourceClass: 'crm-export',
        },
        actorId,
        'tenant-a',
      );

      expect(mockSourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: sourceId.toString(), tenantId: 'tenant-a' },
        {
          $set: {
            connectivity: 'export-only',
            reachability: 'possible',
            owner: 'Jane Doe, IT',
            tracked: false,
            sourceClass: 'crm-export',
            previousSourceClass: 'unclassified',
          },
        },
        { new: true },
      );
      expect(result.connectivity).toBe('export-only');
      expect(result.tracked).toBe(false);
    });

    it('should not stamp previousSourceClass when sourceClass is re-set to its current value', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource({ sourceClass: 'memo' }));
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockSource({ sourceClass: 'memo' }),
      );

      await service.update(sourceId.toString(), { sourceClass: 'memo' }, actorId, 'tenant-a');

      expect(mockSourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: sourceId.toString(), tenantId: 'tenant-a' },
        { $set: { sourceClass: 'memo' } },
        { new: true },
      );
    });

    it('should not touch sourceClass or previousSourceClass when changing only owner', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(buildMockSource({ sourceClass: 'memo' }));
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockSource({ sourceClass: 'memo', owner: 'Jane Doe, IT' }),
      );

      await service.update(sourceId.toString(), { owner: 'Jane Doe, IT' }, actorId, 'tenant-a');

      expect(mockSourceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: sourceId.toString(), tenantId: 'tenant-a' },
        { $set: { owner: 'Jane Doe, IT' } },
        { new: true },
      );
    });
  });

  describe('getClassDriftReport', () => {
    it('should throw SourceNotFoundException for an unknown source', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getClassDriftReport(sourceId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
    });

    it('should report count: 0 and no previousClass when sourceClass has never changed', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(
        buildMockSource({ previousSourceClass: undefined }),
      );

      const result = await service.getClassDriftReport(sourceId.toString(), actorId, 'tenant-a');

      expect(result).toEqual({ previousClass: undefined, count: 0 });
      expect(mockDocumentsService.countBySourceAndClass).not.toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.class_drift_viewed',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
      });
    });

    it('should count documents still carrying previousSourceClass', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(
        buildMockSource({ sourceClass: 'crm-export', previousSourceClass: 'memo' }),
      );
      mockDocumentsService.countBySourceAndClass.mockResolvedValueOnce(12);

      const result = await service.getClassDriftReport(sourceId.toString(), actorId, 'tenant-a');

      expect(mockDocumentsService.countBySourceAndClass).toHaveBeenCalledWith(
        sourceId,
        'memo',
        'tenant-a',
      );
      expect(result).toEqual({ previousClass: 'memo', count: 12 });
    });
  });

  describe('applyClassDrift', () => {
    it('should throw SourceNotFoundException for an unknown source', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.applyClassDrift(sourceId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
    });

    it('should no-op with modifiedCount: 0 when sourceClass has never changed', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(
        buildMockSource({ previousSourceClass: undefined }),
      );

      const result = await service.applyClassDrift(sourceId.toString(), actorId, 'tenant-a');

      expect(mockDocumentsService.applySourceClassToDrifted).not.toHaveBeenCalled();
      expect(result).toEqual({
        modifiedCount: 0,
        previousClass: undefined,
        sourceClass: 'unclassified',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.class_drift_applied',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
        modifiedCount: 0,
      });
    });

    it('should apply the current sourceClass to documents scoped by previousSourceClass and record the modified count', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(
        buildMockSource({ sourceClass: 'crm-export', previousSourceClass: 'memo' }),
      );
      mockDocumentsService.applySourceClassToDrifted.mockResolvedValueOnce(12);

      const result = await service.applyClassDrift(sourceId.toString(), actorId, 'tenant-a');

      expect(mockDocumentsService.applySourceClassToDrifted).toHaveBeenCalledWith(
        sourceId,
        'memo',
        'crm-export',
        'tenant-a',
      );
      expect(result).toEqual({
        modifiedCount: 12,
        previousClass: 'memo',
        sourceClass: 'crm-export',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.class_drift_applied',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
        modifiedCount: 12,
      });
    });
  });

  describe('requestSync', () => {
    it('should throw SourceNotFoundException for an unknown source', async () => {
      mockSourceModel.findOne.mockResolvedValueOnce(null);

      await expect(
        service.requestSync(sourceId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(SourceNotFoundException);
    });

    it('should start a new sync workflow, record an audit event, and return the run projection', async () => {
      const source = buildMockSource();
      const runProjection = {
        id: 'run-1',
        workflowId: 'wf-sync-1',
        status: 'running',
        errorMessage: undefined,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockSourceModel.findOne.mockResolvedValueOnce(source);
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-sync-1', status: 'running' });
      mockWorkflowRunsService.create.mockResolvedValueOnce(runProjection);

      const result = await service.requestSync(sourceId.toString(), actorId, 'tenant-a');

      expect(mockWorkflowEngine.start).toHaveBeenCalledWith('syncSource', {
        sourceId: sourceId.toString(),
      });
      expect(source.syncWorkflowId).toBe('wf-sync-1');
      expect(source.save).toHaveBeenCalled();
      expect(mockWorkflowRunsService.create).toHaveBeenCalledWith({
        workflowId: 'wf-sync-1',
        workflowType: 'sync-source',
        status: 'running',
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'sources.sync_requested',
        actorId,
        subject: { entityType: 'Source', entityId: sourceId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual(runProjection);
    });

    it('should not start a second workflow and return the existing run when one is still running', async () => {
      const source = buildMockSource({ syncWorkflowId: 'wf-sync-1' });
      const runProjection = {
        id: 'run-1',
        workflowId: 'wf-sync-1',
        status: 'running',
        errorMessage: undefined,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockSourceModel.findOne.mockResolvedValueOnce(source);
      mockWorkflowEngine.status.mockResolvedValueOnce({ id: 'wf-sync-1', status: 'running' });
      mockWorkflowRunsService.findRunByWorkflowId.mockResolvedValueOnce(runProjection);

      const result = await service.requestSync(sourceId.toString(), actorId, 'tenant-a');

      expect(mockWorkflowEngine.start).not.toHaveBeenCalled();
      expect(mockWorkflowRunsService.findRunByWorkflowId).toHaveBeenCalledWith(
        'wf-sync-1',
        'tenant-a',
      );
      expect(result).toEqual(runProjection);
    });

    it('should throw when the recorded workflow is still running but its WorkflowRun row is missing', async () => {
      const source = buildMockSource({ syncWorkflowId: 'wf-sync-1' });
      mockSourceModel.findOne.mockResolvedValueOnce(source);
      mockWorkflowEngine.status.mockResolvedValueOnce({ id: 'wf-sync-1', status: 'running' });
      mockWorkflowRunsService.findRunByWorkflowId.mockResolvedValueOnce(null);

      await expect(
        service.requestSync(sourceId.toString(), actorId, 'tenant-a'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should start a new workflow when the recorded one has already finished', async () => {
      const source = buildMockSource({ syncWorkflowId: 'wf-sync-1' });
      mockSourceModel.findOne.mockResolvedValueOnce(source);
      mockWorkflowEngine.status.mockResolvedValueOnce({ id: 'wf-sync-1', status: 'completed' });
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-sync-2', status: 'running' });
      mockWorkflowRunsService.create.mockResolvedValueOnce({
        id: 'run-2',
        workflowId: 'wf-sync-2',
        status: 'running',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      const result = await service.requestSync(sourceId.toString(), actorId, 'tenant-a');

      expect(mockWorkflowEngine.start).toHaveBeenCalled();
      expect(result.workflowId).toBe('wf-sync-2');
    });

    it('should fail open and start a new workflow when the status lookup throws', async () => {
      const source = buildMockSource({ syncWorkflowId: 'wf-sync-1' });
      mockSourceModel.findOne.mockResolvedValueOnce(source);
      mockWorkflowEngine.status.mockRejectedValueOnce(new Error('engine unreachable'));
      mockWorkflowEngine.start.mockResolvedValueOnce({ id: 'wf-sync-2', status: 'running' });
      mockWorkflowRunsService.create.mockResolvedValueOnce({
        id: 'run-2',
        workflowId: 'wf-sync-2',
        status: 'running',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });

      const result = await service.requestSync(sourceId.toString(), actorId, 'tenant-a');

      expect(mockWorkflowEngine.start).toHaveBeenCalled();
      expect(result.workflowId).toBe('wf-sync-2');
    });
  });

  describe('runSync', () => {
    const leaseToken = new Types.ObjectId();

    it('should exit cleanly when the source no longer exists', async () => {
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(null);

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({ disabled: true, intervalMs: null });
    });

    it('should report disabled and exit without listing files when the source is disabled', async () => {
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(buildMockSource({ enabled: false }));

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({ disabled: true, intervalMs: null });
      expect(mockSourceConnector.listFiles).not.toHaveBeenCalled();
    });

    it('should exit without listing files when the source is inventory-only (tracked: false)', async () => {
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(buildMockSource({ tracked: false }));

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({ disabled: true, intervalMs: null });
      expect(mockSourceConnector.listFiles).not.toHaveBeenCalled();
    });

    it('should exit without listing files for an mcp-submit source even when tracked: true', async () => {
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(
        buildMockSource({ kind: 'mcp-submit', tracked: true }),
      );

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({ disabled: true, intervalMs: null });
      expect(mockSourceConnector.listFiles).not.toHaveBeenCalled();
    });

    it('should record a failed status and continue the recurring schedule when listing files fails', async () => {
      mockSourceModel.findOneAndUpdate
        .mockResolvedValueOnce(buildMockSource({ intervalMs: 5000 }))
        .mockResolvedValueOnce(buildMockSource());
      mockSourceConnector.listFiles.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(getFinalizeUpdate(1).$set).toMatchObject({
        lastSyncStatus: 'failed',
        lastSyncError: 'ENOENT',
      });
      expect(result).toEqual({ disabled: false, intervalMs: 5000 });
    });

    it('should stringify a non-Error rejection when listing files fails', async () => {
      mockSourceModel.findOneAndUpdate
        .mockResolvedValueOnce(buildMockSource({ intervalMs: 5000 }))
        .mockResolvedValueOnce(buildMockSource());
      mockSourceConnector.listFiles.mockRejectedValueOnce('connector unreachable');

      await service.runSync(sourceId.toString(), leaseToken);

      expect(getFinalizeUpdate(1).$set).toMatchObject({ lastSyncError: 'connector unreachable' });
    });

    it('should discard results and exit this loop when the lease is lost before finalizing', async () => {
      mockSourceModel.findOneAndUpdate
        .mockResolvedValueOnce(buildMockSource())
        .mockResolvedValueOnce(null);
      mockSourceConnector.listFiles.mockResolvedValueOnce([]);

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({ disabled: false, intervalMs: null });
    });

    it('should fall back to the global config interval when the source has no override', async () => {
      mockSourceModel.findOneAndUpdate
        .mockResolvedValueOnce(buildMockSource())
        .mockResolvedValueOnce(buildMockSource());
      mockSourceConnector.listFiles.mockResolvedValueOnce([]);

      const result = await service.runSync(sourceId.toString(), leaseToken);

      expect(result).toEqual({
        disabled: false,
        intervalMs: getMockTypedConfig().sources.syncIntervalMs,
      });
    });

    it('should reject a file over the size cap using the listed size, before ever fetching it', async () => {
      const existingState = {
        path: 'huge.pdf',
        sha256: 'e'.repeat(64),
        sizeBytes: 1000,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const source = buildMockSource({ fileStates: [existingState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'huge.pdf', sizeBytes: 60 * 1024 * 1024, mtimeMs: 2000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockSourceConnector.fetchFile).not.toHaveBeenCalled();
      const persisted = getFinalizeUpdate(1).$set.fileStates;
      expect(persisted[0]).toMatchObject({ path: 'huge.pdf', sizeBytes: 1000, mtimeMs: 1000 });
      expect(persisted[0]?.lastError).toEqual(expect.stringContaining('bytes, over the'));
    });

    it('should still reject a file that grew between list and fetch, based on the fetched bytes', async () => {
      const existingState = {
        path: 'grows.pdf',
        sha256: 'f'.repeat(64),
        sizeBytes: 1000,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const source = buildMockSource({ fileStates: [existingState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'grows.pdf', sizeBytes: 2000, mtimeMs: 2000 },
      ]);
      mockSourceConnector.fetchFile.mockResolvedValueOnce(Buffer.alloc(60 * 1024 * 1024));

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockSourceConnector.fetchFile).toHaveBeenCalledWith('grows.pdf');
      const persisted = getFinalizeUpdate(1).$set.fileStates;
      expect(persisted[0]).toMatchObject({ path: 'grows.pdf', sizeBytes: 1000, mtimeMs: 1000 });
      expect(persisted[0]?.lastError).toEqual(expect.stringContaining('bytes, over the'));
    });

    it('should stringify a non-Error rejection when fetching an existing file fails', async () => {
      // Subdocument-shaped so the failure branch's `cloneFileState(existing, { lastError })` is
      // exercised against the same field-access pattern a real `SourceFileState` subdocument uses
      // — a regression to spreading `existing` directly would drop `sha256`/`documentId` here too,
      // not only leave `lastError` unset.
      const existingState = asSubdocumentLikeFileState({
        path: 'flaky.pdf',
        sha256: 'g'.repeat(64),
        sizeBytes: 1000,
        mtimeMs: 1000,
        documentId: documentIdA,
      });
      const source = buildMockSource({ fileStates: [existingState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'flaky.pdf', sizeBytes: 1000, mtimeMs: 2000 },
      ]);
      mockSourceConnector.fetchFile.mockRejectedValueOnce('disk unavailable');

      await service.runSync(sourceId.toString(), leaseToken);

      const persisted = getFinalizeUpdate(1).$set.fileStates;
      expect(persisted[0]).toMatchObject({
        path: 'flaky.pdf',
        sha256: 'g'.repeat(64),
        sizeBytes: 1000,
        mtimeMs: 1000,
        documentId: documentIdA,
        lastError: 'disk unavailable',
      });
    });

    /**
     * One sweep exercising every per-file branch at once: `unchanged.pdf` matches its stored
     * watermark and is never fetched; `touched.pdf`'s watermark moved but its fetched bytes hash
     * to the same sha256 as before (dedupe backstop, watermark-only update, no upload);
     * `changed.pdf` genuinely changed and gets a new version on its existing document;
     * `flaky.pdf` is an existing file whose fetch fails this pass, so its `lastError` is recorded
     * against its OLD, unadvanced watermark; `new.pdf` uploads clean as a brand-new document;
     * `huge.pdf` and `mystery.exe` are brand-new files that fail (oversized, unresolvable kind
     * respectively) and so get a placeholder `fileStates` entry — no `documentId`, no `sha256` —
     * see `syncOneFile`'s own doc comment for what distinguishes a placeholder from a synced entry.
     */
    it('should sync every discovered file and persist the resulting fileStates in one pass', async () => {
      const sameBytesAsBefore = Buffer.from('same-bytes-as-before');
      const unchangedState = {
        path: 'unchanged.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const shaEqualState = {
        path: 'touched.pdf',
        sha256: createHash('sha256').update(sameBytesAsBefore).digest('hex'),
        sizeBytes: 200,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const changedState = {
        path: 'changed.pdf',
        sha256: 'c'.repeat(64),
        sizeBytes: 300,
        mtimeMs: 1000,
        documentId: documentIdB,
      };
      const erroringExistingState = {
        path: 'flaky.pdf',
        sha256: 'd'.repeat(64),
        sizeBytes: 400,
        mtimeMs: 1000,
        documentId: documentIdB,
      };

      const source = buildMockSource({
        fileStates: [unchangedState, shaEqualState, changedState, erroringExistingState],
      });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);

      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'unchanged.pdf', sizeBytes: 100, mtimeMs: 1000 },
        { relativePath: 'touched.pdf', sizeBytes: 250, mtimeMs: 2000 },
        { relativePath: 'changed.pdf', sizeBytes: 320, mtimeMs: 2000 },
        { relativePath: 'flaky.pdf', sizeBytes: 410, mtimeMs: 2000 },
        { relativePath: 'new.pdf', sizeBytes: 50, mtimeMs: 3000 },
        { relativePath: 'huge.pdf', sizeBytes: 60 * 1024 * 1024, mtimeMs: 3000 },
        { relativePath: 'mystery.exe', sizeBytes: 10, mtimeMs: 3000 },
      ]);

      mockSourceConnector.fetchFile.mockImplementation((relativePath: string) => {
        if (relativePath === 'touched.pdf') {
          return Promise.resolve(sameBytesAsBefore);
        }
        if (relativePath === 'changed.pdf') {
          return Promise.resolve(Buffer.from('genuinely-different-bytes'));
        }
        if (relativePath === 'flaky.pdf') {
          return Promise.reject(new Error('disk read error'));
        }
        if (relativePath === 'new.pdf') {
          return Promise.resolve(Buffer.from('brand-new-bytes'));
        }
        if (relativePath === 'mystery.exe') {
          return Promise.resolve(Buffer.from('binary'));
        }
        throw new Error(`unexpected fetch for ${relativePath}`);
      });

      const newDocumentId = new Types.ObjectId();
      mockDocumentsService.upload
        .mockResolvedValueOnce({ id: documentIdB.toString() })
        .mockResolvedValueOnce({ id: newDocumentId.toString() });

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockSourceConnector.fetchFile).not.toHaveBeenCalledWith('unchanged.pdf');
      expect(mockSourceConnector.fetchFile).not.toHaveBeenCalledWith('huge.pdf');
      expect(mockDocumentsService.upload).toHaveBeenCalledTimes(2);
      expect(mockDocumentsService.upload).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'changed.pdf' }),
        { documentId: documentIdB.toString() },
        DEFAULT_TENANT_ID,
        { path: 'changed.pdf', sourceId },
      );
      expect(mockDocumentsService.upload).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'new.pdf' }),
        { title: 'new.pdf' },
        DEFAULT_TENANT_ID,
        { sourceClass: 'unclassified', sourceId, path: 'new.pdf' },
      );

      const persistedFileStates = getFinalizeUpdate(1).$set.fileStates;
      const byPath = new Map(persistedFileStates.map((state) => [state.path, state]));

      expect(byPath.get('unchanged.pdf')).toEqual(unchangedState);
      expect(byPath.get('touched.pdf')).toMatchObject({
        sizeBytes: 250,
        mtimeMs: 2000,
        documentId: documentIdA,
      });
      expect(byPath.get('changed.pdf')).toMatchObject({
        sizeBytes: 320,
        mtimeMs: 2000,
        documentId: documentIdB,
      });
      expect(byPath.get('flaky.pdf')).toMatchObject({
        sizeBytes: 400,
        mtimeMs: 1000,
        lastError: 'disk read error',
      });
      expect(byPath.get('new.pdf')).toMatchObject({ documentId: newDocumentId });
      expect(byPath.get('huge.pdf')).toEqual({
        path: 'huge.pdf',
        sizeBytes: 60 * 1024 * 1024,
        mtimeMs: 3000,
        lastError: `'huge.pdf' is ${60 * 1024 * 1024} bytes, over the ${MAX_FILE_SIZE_BYTES}-byte sync limit`,
      });
      expect(byPath.get('mystery.exe')).toEqual({
        path: 'mystery.exe',
        sizeBytes: 10,
        mtimeMs: 3000,
        lastError: "Could not resolve a document type for 'mystery.exe'",
      });
    });

    it('should retry a placeholder entry on every sweep, even when its watermark matches, since it was never synced', async () => {
      const placeholderState = {
        path: 'mystery.exe',
        sizeBytes: 10,
        mtimeMs: 3000,
        lastError: "Could not resolve a document type for 'mystery.exe'",
      };

      const source = buildMockSource({ fileStates: [placeholderState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'mystery.exe', sizeBytes: 10, mtimeMs: 3000 },
      ]);
      mockSourceConnector.fetchFile.mockResolvedValueOnce(Buffer.from('binary'));

      await service.runSync(sourceId.toString(), leaseToken);

      // A synced entry with an identical watermark is skipped by the cheap check and never
      // refetched (asserted above, `unchanged.pdf`); a placeholder has no `documentId` and must
      // never take that shortcut, or an unresolvable-kind file would stop being retried the moment
      // its size and mtime happened to match its own failed attempt.
      expect(mockSourceConnector.fetchFile).toHaveBeenCalledWith('mystery.exe');
      const persisted = getFinalizeUpdate(1).$set.fileStates.find(
        (state) => state.path === 'mystery.exe',
      );
      expect(persisted).toEqual({
        path: 'mystery.exe',
        sizeBytes: 10,
        mtimeMs: 3000,
        lastError: "Could not resolve a document type for 'mystery.exe'",
      });
    });

    it('should not withdraw a document version on the first absent sweep, only on the second consecutive one', async () => {
      const staysDocumentId = new Types.ObjectId();
      const goneDocumentId = new Types.ObjectId();
      const staysState = {
        path: 'stays.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: staysDocumentId,
      };
      const goneState = asSubdocumentLikeFileState({
        path: 'gone.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
        mtimeMs: 1000,
        documentId: goneDocumentId,
      });

      let source = buildMockSource({ fileStates: [staysState, goneState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
      const sweep1FileStates = getFinalizeUpdate(1).$set.fileStates;
      const sweep1Gone = sweep1FileStates.find((state) => state.path === 'gone.pdf');
      // Every watermark field, not only `absentSweeps` — a regression to spreading the
      // (subdocument-shaped) source entry directly drops `path`/`sha256`/`documentId`/etc. rather
      // than merely failing to advance the counter, and `toMatchObject({ absentSweeps: 1 })` alone
      // would not catch that.
      expect(sweep1Gone).toMatchObject({
        path: 'gone.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
        mtimeMs: 1000,
        documentId: goneDocumentId,
        absentSweeps: 1,
      });
      expect(sweep1Gone?.withdrawnAt).toBeUndefined();

      // The next sweep reads these entries back off a fresh `buildMockSource`, so they are plain
      // objects again here — mirroring a real second sync pass, which always re-hydrates
      // subdocuments from what the previous pass actually persisted.
      source = buildMockSource({ fileStates: sweep1FileStates });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);
      // No location remains once this, the document's only known location, is forgotten.
      mockDocumentsService.forgetLocation.mockResolvedValueOnce(0);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.forgetLocation).toHaveBeenCalledWith(
        goneDocumentId,
        { path: 'gone.pdf', sourceId },
        DEFAULT_TENANT_ID,
      );
      // `withdrawVersions` receiving the correct `documentId` is the assertion the earlier bug
      // failed silently: a corrupted `gone.pdf` entry loses `documentId` on the first sweep, so
      // this call either never fires or fires with `undefined` in the array.
      expect(mockDocumentsService.withdrawVersions).toHaveBeenCalledWith(
        [goneDocumentId],
        'source-file-absent',
        DEFAULT_TENANT_ID,
      );
      const sweep2FileStates = getFinalizeUpdate(3).$set.fileStates;
      const sweep2Gone = sweep2FileStates.find((state) => state.path === 'gone.pdf');
      expect(sweep2Gone).toMatchObject({
        path: 'gone.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
        mtimeMs: 1000,
        documentId: goneDocumentId,
        absentSweeps: 2,
      });
      expect(sweep2Gone?.withdrawnAt).toBeInstanceOf(Date);
    });

    it.each([
      { name: 'absent-twice-last-location', forgetLocationRemaining: 0, expectWithdraw: true },
      {
        name: 'absent-twice-other-location-remains',
        forgetLocationRemaining: 1,
        expectWithdraw: false,
      },
    ])(
      'should withdraw a document only when forgetLocation reports no location remains ($name)',
      async ({ forgetLocationRemaining, expectWithdraw }) => {
        const staysDocumentId = new Types.ObjectId();
        const goneDocumentId = new Types.ObjectId();
        const staysState = {
          path: 'stays.pdf',
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          mtimeMs: 1000,
          documentId: staysDocumentId,
        };
        // Already on its second strike — this single sweep is what pushes it over the two-strike
        // threshold, so the forget/withdraw decision is exercised without a second `runSync` call.
        const goneState = {
          path: 'gone.pdf',
          sha256: 'b'.repeat(64),
          sizeBytes: 200,
          mtimeMs: 1000,
          documentId: goneDocumentId,
          absentSweeps: 1,
        };
        const source = buildMockSource({ fileStates: [staysState, goneState] });
        mockSourceModel.findOneAndUpdate
          .mockResolvedValueOnce(source)
          .mockResolvedValueOnce(source);
        mockSourceConnector.listFiles.mockResolvedValueOnce([
          { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
        ]);
        mockDocumentsService.forgetLocation.mockResolvedValueOnce(forgetLocationRemaining);

        await service.runSync(sourceId.toString(), leaseToken);

        expect(mockDocumentsService.forgetLocation).toHaveBeenCalledWith(
          goneDocumentId,
          { path: 'gone.pdf', sourceId },
          DEFAULT_TENANT_ID,
        );
        if (expectWithdraw) {
          expect(mockDocumentsService.withdrawVersions).toHaveBeenCalledWith(
            [goneDocumentId],
            'source-file-absent',
            DEFAULT_TENANT_ID,
          );
        } else {
          expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
        }
      },
    );

    it('should mark a placeholder entry withdrawn on the second absent sweep without calling withdrawVersions', async () => {
      const staysDocumentId = new Types.ObjectId();
      const staysState = {
        path: 'stays.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: staysDocumentId,
      };
      const placeholderState = asSubdocumentLikeFileState({
        path: 'mystery.exe',
        sizeBytes: 10,
        mtimeMs: 3000,
        lastError: "Could not resolve a document type for 'mystery.exe'",
      });

      let source = buildMockSource({ fileStates: [staysState, placeholderState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      const sweep1FileStates = getFinalizeUpdate(1).$set.fileStates;
      source = buildMockSource({ fileStates: sweep1FileStates });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      // A placeholder was never ingested, so there is no location to forget and no document
      // version to withdraw — only `stays.pdf`'s real entry could ever appear here, and it never
      // goes absent in this test.
      expect(mockDocumentsService.forgetLocation).not.toHaveBeenCalled();
      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
      const sweep2FileStates = getFinalizeUpdate(3).$set.fileStates;
      const sweep2Placeholder = sweep2FileStates.find((state) => state.path === 'mystery.exe');
      expect(sweep2Placeholder).toMatchObject({
        path: 'mystery.exe',
        sizeBytes: 10,
        mtimeMs: 3000,
        absentSweeps: 2,
      });
      expect(sweep2Placeholder?.documentId).toBeUndefined();
      expect(sweep2Placeholder?.withdrawnAt).toBeInstanceOf(Date);
    });

    it('should reset absentSweeps when a path reappears via the cheap watermark match, so a later unrelated absence restarts the two-strike count', async () => {
      const staysDocumentId = new Types.ObjectId();
      const flickerDocumentId = new Types.ObjectId();
      const staysState = {
        path: 'stays.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: staysDocumentId,
      };
      const flickerState = {
        path: 'flicker.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 200,
        mtimeMs: 2000,
        documentId: flickerDocumentId,
      };

      // Sweep 1: flicker.pdf absent, stays.pdf present — first strike.
      let source = buildMockSource({ fileStates: [staysState, flickerState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);
      await service.runSync(sourceId.toString(), leaseToken);
      let fileStates = getFinalizeUpdate(1).$set.fileStates;
      expect(fileStates.find((state) => state.path === 'flicker.pdf')).toMatchObject({
        absentSweeps: 1,
      });

      // Sweep 2: flicker.pdf reappears with its ORIGINAL, unchanged watermark — the cheap
      // early-return must clear the strike rather than let it compound with a later, unrelated
      // absence.
      source = buildMockSource({ fileStates });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
        { relativePath: 'flicker.pdf', sizeBytes: 200, mtimeMs: 2000 },
      ]);
      await service.runSync(sourceId.toString(), leaseToken);
      expect(mockSourceConnector.fetchFile).not.toHaveBeenCalledWith('flicker.pdf');
      fileStates = getFinalizeUpdate(3).$set.fileStates;
      expect(
        fileStates.find((state) => state.path === 'flicker.pdf')?.absentSweeps,
      ).toBeUndefined();

      // Sweep 3: flicker.pdf absent again — a fresh first strike, not a second, so no withdrawal.
      source = buildMockSource({ fileStates });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stays.pdf', sizeBytes: 100, mtimeMs: 1000 },
      ]);
      await service.runSync(sourceId.toString(), leaseToken);
      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
      fileStates = getFinalizeUpdate(5).$set.fileStates;
      expect(fileStates.find((state) => state.path === 'flicker.pdf')).toMatchObject({
        absentSweeps: 1,
      });
    });

    it('should clear a stale absentSweeps count without dropping the rest of the watermark on a live Mongoose-subdocument-shaped entry', async () => {
      // Isolates `syncOneFile`'s cheap-watermark-match reset branch (the one other paths in this
      // file reach only after the entry has already round-tripped through a prior sweep's plain
      // `cloneFileState` output, which would mask a regression to spreading `existing` directly).
      const staleDocumentId = new Types.ObjectId();
      const staleState = asSubdocumentLikeFileState({
        path: 'stale-strike.pdf',
        sha256: 'e'.repeat(64),
        sizeBytes: 300,
        mtimeMs: 5000,
        documentId: staleDocumentId,
        absentSweeps: 1,
      });
      const source = buildMockSource({ fileStates: [staleState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'stale-strike.pdf', sizeBytes: 300, mtimeMs: 5000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockSourceConnector.fetchFile).not.toHaveBeenCalled();
      const persisted = getFinalizeUpdate(1).$set.fileStates.find(
        (state) => state.path === 'stale-strike.pdf',
      );
      expect(persisted).toMatchObject({
        path: 'stale-strike.pdf',
        sha256: 'e'.repeat(64),
        sizeBytes: 300,
        mtimeMs: 5000,
        documentId: staleDocumentId,
      });
      expect(persisted?.absentSweeps).toBeUndefined();
    });

    it('should suppress withdrawal, record it, and leave absentSweeps untouched when the fresh listing is empty but known files exist', async () => {
      const knownState = {
        path: 'exists.pdf',
        sha256: 'c'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const source = buildMockSource({ fileStates: [knownState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([]);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
      const update = getFinalizeUpdate(1);
      expect(update.$set.lastWithdrawalSuppressedReason).toBe('empty-listing');
      expect(update.$set.lastWithdrawalSuppressedAt).toBeInstanceOf(Date);
      expect(update.$set.fileStates.find((state) => state.path === 'exists.pdf')).toEqual(
        knownState,
      );
    });

    it('should suppress withdrawal, record it, and leave absentSweeps untouched when more than half of known files are absent', async () => {
      const presentState = {
        path: 'present.pdf',
        sha256: 'd'.repeat(64),
        sizeBytes: 10,
        mtimeMs: 1000,
        documentId: documentIdA,
      };
      const absentState1 = {
        path: 'absent1.pdf',
        sha256: 'e'.repeat(64),
        sizeBytes: 20,
        mtimeMs: 1000,
        documentId: documentIdB,
      };
      const absentState2 = {
        path: 'absent2.pdf',
        sha256: 'f'.repeat(64),
        sizeBytes: 30,
        mtimeMs: 1000,
        documentId: new Types.ObjectId(),
      };
      const source = buildMockSource({
        fileStates: [presentState, absentState1, absentState2],
      });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'present.pdf', sizeBytes: 10, mtimeMs: 1000 },
      ]);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
      const update = getFinalizeUpdate(1);
      expect(update.$set.lastWithdrawalSuppressedReason).toBe('absence-threshold-exceeded');
      expect(
        update.$set.fileStates.find((state) => state.path === 'absent1.pdf')?.absentSweeps,
      ).toBeUndefined();
      expect(
        update.$set.fileStates.find((state) => state.path === 'absent2.pdf')?.absentSweeps,
      ).toBeUndefined();
    });

    it('should not call withdrawVersions when listing files fails', async () => {
      mockSourceModel.findOneAndUpdate
        .mockResolvedValueOnce(buildMockSource())
        .mockResolvedValueOnce(buildMockSource());
      mockSourceConnector.listFiles.mockRejectedValueOnce(new Error('ENOENT'));

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.withdrawVersions).not.toHaveBeenCalled();
    });

    it('should force a hash check and reinstate a withdrawn version when a path reappears with a byte-identical watermark', async () => {
      const restoredBytes = Buffer.from('restored-bytes-unchanged');
      const restoredSha256 = createHash('sha256').update(restoredBytes).digest('hex');
      const withdrawnDocumentId = new Types.ObjectId();
      // Subdocument-shaped so the dedupe branch's `cloneFileState(existing, { ... })` reads through
      // the same getter pattern the real `SourceFileStateSchema` subdocument uses — a regression to
      // spreading `existing` directly drops `path` from the persisted entry, which would make the
      // `.find(state => state.path === 'restored.pdf')` below silently return `undefined` and the
      // two `toBeUndefined()` checks pass for the wrong reason.
      const withdrawnState = asSubdocumentLikeFileState({
        path: 'restored.pdf',
        sha256: restoredSha256,
        sizeBytes: 500,
        mtimeMs: 4000,
        documentId: withdrawnDocumentId,
        absentSweeps: 2,
        withdrawnAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      const source = buildMockSource({ fileStates: [withdrawnState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'restored.pdf', sizeBytes: 500, mtimeMs: 4000 },
      ]);
      mockSourceConnector.fetchFile.mockResolvedValueOnce(restoredBytes);

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockSourceConnector.fetchFile).toHaveBeenCalledWith('restored.pdf');
      // The location this path names was forgotten off its document by whichever earlier sweep
      // withdrew it — re-registering it here is what a withdrawn-then-returned path requires
      // (`syncOneFile`'s own doc comment).
      expect(mockDocumentsService.recordLocation).toHaveBeenCalledWith(
        withdrawnDocumentId,
        { path: 'restored.pdf', sourceId },
        DEFAULT_TENANT_ID,
      );
      expect(mockDocumentsService.reinstateVersions).toHaveBeenCalledWith(
        [withdrawnDocumentId],
        DEFAULT_TENANT_ID,
      );
      const persisted = getFinalizeUpdate(1).$set.fileStates.find(
        (state) => state.path === 'restored.pdf',
      );
      // `find` returning a match at all is itself part of the regression coverage — an
      // optional-chained assertion on a `find` miss reads as a pass either way.
      expect(persisted).toBeDefined();
      expect(persisted).toMatchObject({
        path: 'restored.pdf',
        sha256: restoredSha256,
        sizeBytes: 500,
        mtimeMs: 4000,
        documentId: withdrawnDocumentId,
      });
      expect(persisted?.withdrawnAt).toBeUndefined();
      expect(persisted?.absentSweeps).toBeUndefined();
    });

    it('should reinstate the whole document when a withdrawn path reappears with genuinely different bytes', async () => {
      const withdrawnDocumentId = new Types.ObjectId();
      const withdrawnState = {
        path: 'changed-after-withdrawal.pdf',
        sha256: 'c'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: withdrawnDocumentId,
        absentSweeps: 2,
        withdrawnAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      const source = buildMockSource({ fileStates: [withdrawnState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'changed-after-withdrawal.pdf', sizeBytes: 150, mtimeMs: 2000 },
      ]);
      mockSourceConnector.fetchFile.mockResolvedValueOnce(Buffer.from('genuinely-new-bytes'));
      mockDocumentsService.upload.mockResolvedValueOnce({ id: withdrawnDocumentId.toString() });

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.upload).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'changed-after-withdrawal.pdf' }),
        { documentId: withdrawnDocumentId.toString() },
        DEFAULT_TENANT_ID,
        { path: 'changed-after-withdrawal.pdf', sourceId },
      );
      expect(mockDocumentsService.reinstateVersions).toHaveBeenCalledWith(
        [withdrawnDocumentId],
        DEFAULT_TENANT_ID,
      );
    });

    it('should re-point the fileState documentId to whatever document upload resolves to when synced bytes converge onto a different, already-existing document', async () => {
      const trackedDocumentId = new Types.ObjectId();
      const convergedOntoDocumentId = new Types.ObjectId();
      const trackedState = {
        path: 'converges.pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        mtimeMs: 1000,
        documentId: trackedDocumentId,
      };
      const source = buildMockSource({ fileStates: [trackedState] });
      mockSourceModel.findOneAndUpdate.mockResolvedValueOnce(source).mockResolvedValueOnce(source);
      mockSourceConnector.listFiles.mockResolvedValueOnce([
        { relativePath: 'converges.pdf', sizeBytes: 120, mtimeMs: 2000 },
      ]);
      mockSourceConnector.fetchFile.mockResolvedValueOnce(
        Buffer.from('now-matches-another-document'),
      );
      mockDocumentsService.upload.mockResolvedValueOnce({ id: convergedOntoDocumentId.toString() });

      await service.runSync(sourceId.toString(), leaseToken);

      expect(mockDocumentsService.upload).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'converges.pdf' }),
        { documentId: trackedDocumentId.toString() },
        DEFAULT_TENANT_ID,
        { path: 'converges.pdf', sourceId },
      );
      const persisted = getFinalizeUpdate(1).$set.fileStates.find(
        (state) => state.path === 'converges.pdf',
      );
      expect(persisted).toMatchObject({ documentId: convergedOntoDocumentId });
    });
  });

  describe('findTenantIdForSync', () => {
    it('should return undefined for a malformed id, without querying the model', async () => {
      const result = await service.findTenantIdForSync('not-an-object-id');

      expect(result).toBeUndefined();
      expect(mockSourceModel.findById).not.toHaveBeenCalled();
    });

    it('should return undefined when no source matches the id', async () => {
      mockSourceModel.findById.mockResolvedValueOnce(null);

      const result = await service.findTenantIdForSync(sourceId.toString());

      expect(result).toBeUndefined();
    });

    it("should return the source's tenantId, projecting only that field", async () => {
      mockSourceModel.findById.mockResolvedValueOnce({ tenantId: DEFAULT_TENANT_ID });

      const result = await service.findTenantIdForSync(sourceId.toString());

      expect(mockSourceModel.findById).toHaveBeenCalledWith(sourceId.toString(), { tenantId: 1 });
      expect(result).toBe(DEFAULT_TENANT_ID);
    });
  });
});
