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

  const mockEvidenceRetrievalService = { searchEvidence: jest.fn() };
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

  it('should call EvidenceRetrievalService.searchEvidence with the query, tenant and paging defaults', async () => {
    mockEvidenceRetrievalService.searchEvidence.mockResolvedValueOnce({
      chunks: [],
      hasMore: false,
    });

    await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(mockEvidenceRetrievalService.searchEvidence).toHaveBeenCalledWith({
      questionText: 'What is the cap rate?',
      tenantId: 'tenant-1',
      skip: 0,
      limit: 20,
      sortDirection: 'desc',
      filter: {
        documentId: undefined,
        sourceClass: undefined,
        createdAfter: undefined,
        createdBefore: undefined,
      },
    });
  });

  it('should thread the caller-supplied skip, limit, sort direction and filters through unchanged', async () => {
    mockEvidenceRetrievalService.searchEvidence.mockResolvedValueOnce({
      chunks: [],
      hasMore: false,
    });
    const createdAfter = new Date('2026-01-01T00:00:00.000Z');
    const createdBefore = new Date('2026-06-01T00:00:00.000Z');

    await service.search(
      {
        query: 'What is the cap rate?',
        skip: 40,
        limit: 10,
        sortDir: 'asc',
        documentId: '65f1c2e4a1b2c3d4e5f6a7b8',
        sourceClass: 'memo',
        createdAfter,
        createdBefore,
      },
      'actor-1',
      'tenant-1',
    );

    expect(mockEvidenceRetrievalService.searchEvidence).toHaveBeenCalledWith({
      questionText: 'What is the cap rate?',
      tenantId: 'tenant-1',
      skip: 40,
      limit: 10,
      sortDirection: 'asc',
      filter: {
        documentId: '65f1c2e4a1b2c3d4e5f6a7b8',
        sourceClass: 'memo',
        createdAfter,
        createdBefore,
      },
    });
  });

  it('should record an evidence.searched audit event scoped to the actor and tenant', async () => {
    mockEvidenceRetrievalService.searchEvidence.mockResolvedValueOnce({
      chunks: [],
      hasMore: false,
    });

    await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(mockAuditService.record).toHaveBeenCalledWith({
      action: 'evidence.searched',
      actorId: 'actor-1',
      subject: { entityType: 'User', entityId: 'actor-1' },
      tenantId: 'tenant-1',
    });
  });

  it("should pass through the retrieval service's hits as docs, with hasMore carried unchanged", async () => {
    const hits = [buildChunk(), buildChunk({ chunkId: 'chunk-2' })];
    mockEvidenceRetrievalService.searchEvidence.mockResolvedValueOnce({
      chunks: hits,
      hasMore: true,
    });

    const result = await service.search({ query: 'What is the cap rate?' }, 'actor-1', 'tenant-1');

    expect(result).toEqual({ docs: hits, hasMore: true });
  });

  it('should return an empty result without error when no hits are found', async () => {
    mockEvidenceRetrievalService.searchEvidence.mockResolvedValueOnce({
      chunks: [],
      hasMore: false,
    });

    const result = await service.search({ query: 'no matches' }, 'actor-1', 'tenant-1');

    expect(result).toEqual({ docs: [], hasMore: false });
  });
});
