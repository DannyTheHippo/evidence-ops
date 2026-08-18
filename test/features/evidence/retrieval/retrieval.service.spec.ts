import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { RetrievalService } from '../../../../src/features/evidence/retrieval/retrieval.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

describe('RetrievalService', () => {
  let service: RetrievalService;

  const mockEvidenceRetrievalService = { retrieve: jest.fn() };
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const buildChunk = (overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
    chunkId: 'chunk-1',
    docVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    text: 'The cap rate for Northgate Business Park is approximately 6.10%.',
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetrievalService,
        { provide: EvidenceRetrievalService, useValue: mockEvidenceRetrievalService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<RetrievalService>(RetrievalService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should call EvidenceRetrievalService.retrieve with the query and tenant', async () => {
    mockEvidenceRetrievalService.retrieve.mockResolvedValueOnce([]);

    await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(mockEvidenceRetrievalService.retrieve).toHaveBeenCalledWith({
      questionText: 'What is the cap rate?',
      tenantId: 'tenant-1',
    });
  });

  it('should record an evidence.searched audit event scoped to the actor and tenant', async () => {
    mockEvidenceRetrievalService.retrieve.mockResolvedValueOnce([]);

    await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(mockAuditService.record).toHaveBeenCalledWith({
      action: 'evidence.searched',
      actorId: 'actor-1',
      subject: { entityType: 'User', entityId: 'actor-1' },
      tenantId: 'tenant-1',
    });
  });

  it("should pass through the retrieval service's hits as docs, with count matching their length", async () => {
    const hits = [buildChunk(), buildChunk({ chunkId: 'chunk-2' })];
    mockEvidenceRetrievalService.retrieve.mockResolvedValueOnce(hits);

    const result = await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(result).toEqual({ docs: hits, count: 2 });
  });

  it('should return an empty result without error when no hits are found', async () => {
    mockEvidenceRetrievalService.retrieve.mockResolvedValueOnce([]);

    const result = await service.search({ query: 'no matches' }, 'actor-1', 'tenant-1');

    expect(result).toEqual({ docs: [], count: 0 });
  });
});
