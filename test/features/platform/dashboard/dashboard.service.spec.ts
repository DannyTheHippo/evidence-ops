import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  type DocumentVersionIngestionStatus,
} from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { Source } from '../../../../src/database/schemas/evidence/source/source.schema';
import { Approval } from '../../../../src/database/schemas/workflow/approval/approval.schema';
import { DashboardService } from '../../../../src/features/platform/dashboard/dashboard.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('DashboardService', () => {
  let service: DashboardService;

  const mockApprovalModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockDocumentModel = getMockModel();
  const mockDocumentVersionModel = getMockModel();
  const mockSourceModel = getMockModel();
  const mockAnswerModel = getMockModel();
  const mockLogger = getMockLogger();

  const failedVersionId = new Types.ObjectId();
  const needsOcrVersionId = new Types.ObjectId();
  const factsFailedVersionId = new Types.ObjectId();
  const completedVersionId = new Types.ObjectId();

  const versionIdByStatus: Record<DocumentVersionIngestionStatus, Types.ObjectId[]> = {
    pending: [],
    failed: [failedVersionId],
    'needs-ocr': [needsOcrVersionId],
    'facts-failed': [factsFailedVersionId],
    completed: [completedVersionId],
  };

  // Keyed on which status's version-id array the caller passed as `currentVersionId.$in`, rather
  // than call order — the four derived counts fire inside one `Promise.all` and the service makes
  // no promise about which settles first.
  const countByVersionId = (versionId: Types.ObjectId, counts: Partial<Record<string, number>>) =>
    counts[versionId.toString()] ?? 0;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: getModelToken(Approval.name), useValue: mockApprovalModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(Source.name), useValue: mockSourceModel },
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);

    mockDocumentVersionModel.find.mockImplementation(
      (filter: { ingestionStatus: DocumentVersionIngestionStatus }) =>
        Promise.resolve(versionIdByStatus[filter.ingestionStatus].map((_id) => ({ _id }))),
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getSummary', () => {
    it('assembles every count from its own tenant-scoped query', async () => {
      mockApprovalModel.countDocuments.mockResolvedValueOnce(2);
      mockConflictModel.countDocuments.mockResolvedValueOnce(1);
      mockDocumentModel.countDocuments
        .mockImplementationOnce(() => Promise.resolve(128))
        .mockImplementation((filter: { currentVersionId: { $in: Types.ObjectId[] } }) =>
          Promise.resolve(
            countByVersionId(filter.currentVersionId.$in[0], {
              [failedVersionId.toString()]: 2,
              [needsOcrVersionId.toString()]: 3,
              [factsFailedVersionId.toString()]: 1,
            }),
          ),
        );
      mockSourceModel.countDocuments
        .mockImplementationOnce(() => Promise.resolve(4))
        .mockImplementationOnce(() => Promise.resolve(1));
      mockAnswerModel.countDocuments.mockResolvedValueOnce(12);
      mockDocumentModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });

      const result = await service.getSummary('tenant-a');

      expect(mockApprovalModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        state: 'pending',
      });
      expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        status: 'open',
      });
      expect(mockDocumentModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(mockSourceModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(mockSourceModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        lastSyncStatus: 'failed',
      });
      expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', ingestionStatus: 'failed' },
        { _id: 1 },
      );
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', ingestionStatus: 'needs-ocr' },
        { _id: 1 },
      );
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', ingestionStatus: 'facts-failed' },
        { _id: 1 },
      );
      expect(mockDocumentVersionModel.find).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', ingestionStatus: 'completed' },
        { _id: 1 },
      );
      expect(mockDocumentModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        currentVersionId: { $in: [failedVersionId] },
      });
      expect(mockDocumentModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        currentVersionId: { $in: [needsOcrVersionId] },
      });
      expect(mockDocumentModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        currentVersionId: { $in: [factsFailedVersionId] },
      });
      expect(mockDocumentModel.exists).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        currentVersionId: { $in: [completedVersionId] },
      });
      expect(result).toEqual({
        pendingApprovalCount: 2,
        openConflictCount: 1,
        documentCount: 128,
        sourceCount: 4,
        ingestionFailedCount: 2,
        syncFailedCount: 1,
        needsOcrCount: 3,
        factsFailedCount: 1,
        answerCount: 12,
        hasIngestedDocument: true,
      });
    });

    it('reports hasIngestedDocument false when exists resolves null', async () => {
      mockApprovalModel.countDocuments.mockResolvedValueOnce(0);
      mockConflictModel.countDocuments.mockResolvedValueOnce(0);
      mockDocumentModel.countDocuments.mockResolvedValue(0);
      mockSourceModel.countDocuments.mockResolvedValue(0);
      mockAnswerModel.countDocuments.mockResolvedValueOnce(0);
      mockDocumentModel.exists.mockResolvedValueOnce(null);

      const result = await service.getSummary('tenant-a');

      expect(result.hasIngestedDocument).toBe(false);
    });
  });
});
