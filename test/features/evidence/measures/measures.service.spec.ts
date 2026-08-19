import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { Conflict } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('MeasuresService', () => {
  let service: MeasuresService;

  const mockAnswerModel = getMockModel();
  const mockConflictModel = getMockModel();
  const mockEvidenceChunkModel = getMockModel();
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeasuresService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: getModelToken(Conflict.name), useValue: mockConflictModel },
        { provide: getModelToken(EvidenceChunk.name), useValue: mockEvidenceChunkModel },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<MeasuresService>(MeasuresService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('reports null for the three derived figures when there are no completed answers, without querying evidence chunks', async () => {
    mockAnswerModel.countDocuments.mockResolvedValueOnce(3); // answersCompleted
    mockAnswerModel.countDocuments.mockResolvedValueOnce(1); // answersWithVerifiedCitations
    mockConflictModel.countDocuments.mockResolvedValueOnce(5); // conflictsSurfaced
    mockConflictModel.countDocuments.mockResolvedValueOnce(2); // conflictsResolved
    mockAnswerModel.find.mockResolvedValueOnce([]);

    const result = await service.getForTenant('tenant-a');

    expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      runStatus: 'completed',
    });
    expect(mockAnswerModel.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      runStatus: 'completed',
      'outcome.kind': 'answered',
    });
    expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
    expect(mockConflictModel.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      status: 'resolved',
    });
    expect(mockAnswerModel.find).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', runStatus: 'completed' },
      { retrievedChunkIds: 1, createdAt: 1, updatedAt: 1 },
    );
    expect(mockEvidenceChunkModel.find).not.toHaveBeenCalled();
    expect(result).toEqual({
      answersCompleted: 3,
      answersWithVerifiedCitations: 1,
      conflictsSurfaced: 5,
      conflictsResolved: 2,
      meanEvidenceDocumentsPerAnswer: null,
      medianAnswerLatencyMs: null,
      p95AnswerLatencyMs: null,
    });
  });

  it('computes an even-length median and p95 by interpolation, and skips the chunk query when no completed answer retrieved any chunk', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    mockAnswerModel.countDocuments.mockResolvedValueOnce(2);
    mockAnswerModel.countDocuments.mockResolvedValueOnce(2);
    mockConflictModel.countDocuments.mockResolvedValueOnce(0);
    mockConflictModel.countDocuments.mockResolvedValueOnce(0);
    mockAnswerModel.find.mockResolvedValueOnce([
      { retrievedChunkIds: [], createdAt: start, updatedAt: new Date(start.getTime() + 1000) },
      { retrievedChunkIds: [], createdAt: start, updatedAt: new Date(start.getTime() + 3000) },
    ]);

    const result = await service.getForTenant('tenant-a');

    expect(mockEvidenceChunkModel.find).not.toHaveBeenCalled();
    // Sorted latencies [1000, 3000]. Median: rank = 0.5 * 1 = 0.5 -> 1000 + (3000-1000)*0.5 = 2000.
    // p95: rank = 0.95 * 1 = 0.95 -> 1000 + (3000-1000)*0.95 = 2900.
    expect(result.medianAnswerLatencyMs).toBe(2000);
    expect(result.p95AnswerLatencyMs).toBe(2900);
    // No completed answer retrieved a chunk, so the mean is measured and zero, not null.
    expect(result.meanEvidenceDocumentsPerAnswer).toBe(0);
  });

  it('resolves distinct documents per answer over the odd-length median exact rank, treating a chunk with no matching row as contributing no document', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const documentOne = new Types.ObjectId();
    const documentTwo = new Types.ObjectId();
    mockAnswerModel.countDocuments.mockResolvedValueOnce(3);
    mockAnswerModel.countDocuments.mockResolvedValueOnce(3);
    mockConflictModel.countDocuments.mockResolvedValueOnce(0);
    mockConflictModel.countDocuments.mockResolvedValueOnce(0);
    mockAnswerModel.find.mockResolvedValueOnce([
      // Two chunks from the same document — the distinct count for this answer is 1, not 2.
      {
        retrievedChunkIds: ['chunk-a', 'chunk-b'],
        createdAt: start,
        updatedAt: new Date(start.getTime() + 1000),
      },
      // One resolvable chunk plus one referencing a document that no longer exists.
      {
        retrievedChunkIds: ['chunk-c', 'chunk-missing'],
        createdAt: start,
        updatedAt: new Date(start.getTime() + 2000),
      },
      // No retrieved chunks at all — contributes 0 documents and never enters the per-chunk loop.
      { retrievedChunkIds: [], createdAt: start, updatedAt: new Date(start.getTime() + 10000) },
    ]);
    mockEvidenceChunkModel.find.mockResolvedValueOnce([
      { _id: 'chunk-a', documentId: documentOne },
      { _id: 'chunk-b', documentId: documentOne },
      { _id: 'chunk-c', documentId: documentTwo },
    ]);

    const result = await service.getForTenant('tenant-a');

    expect(mockEvidenceChunkModel.find).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', _id: { $in: ['chunk-a', 'chunk-b', 'chunk-c', 'chunk-missing'] } },
      { documentId: 1 },
    );
    // Per-answer distinct document counts: 1, 1, 0 -> mean 2/3.
    expect(result.meanEvidenceDocumentsPerAnswer).toBeCloseTo(2 / 3);
    // Sorted latencies [1000, 2000, 10000]. Median: rank = 0.5 * 2 = 1 (exact) -> 2000.
    // p95: rank = 0.95 * 2 = 1.9 -> 2000 + (10000-2000)*0.9 = 9200.
    expect(result.medianAnswerLatencyMs).toBe(2000);
    expect(result.p95AnswerLatencyMs).toBe(9200);
  });
});
