import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { AnswerPersistenceService } from '../../../../src/features/evidence/qa/answer-persistence.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('AnswerPersistenceService', () => {
  let service: AnswerPersistenceService;
  const mockAnswerModel = getMockModel();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnswerPersistenceService,
        { provide: getModelToken(Answer.name), useValue: mockAnswerModel },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<AnswerPersistenceService>(AnswerPersistenceService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should insert with runStatus completed and default tenantId for an insufficient_evidence outcome', async () => {
    const answerId = new Types.ObjectId();
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'no supporting evidence' };
    mockAnswerModel.create.mockResolvedValueOnce({
      _id: answerId,
      outcome,
      claimCoverage: undefined,
    });

    const result = await service.persist({
      questionText: 'What is the vacancy rate?',
      retrievedChunkIds: [],
      outcome,
      claims: [],
    });

    expect(mockAnswerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        questionText: 'What is the vacancy rate?',
        runStatus: 'completed',
        tenantId: 'default',
        retrievedChunkIds: [],
        outcome,
        claims: [],
        claimCoverage: undefined,
        verificationReport: undefined,
      }),
    );
    expect(result).toEqual({
      answerId: answerId.toString(),
      outcomeKind: 'insufficient_evidence',
      claimCoverage: undefined,
    });
  });

  it('should map retrievedChunkIds to ObjectIds and pass an explicit tenantId and gate fields through for an answered outcome', async () => {
    const answerId = new Types.ObjectId();
    const chunkId = new Types.ObjectId();
    const outcome = {
      kind: 'answered' as const,
      claims: [
        {
          statement: 'The cap rate is approximately 6.10%.',
          citations: [
            {
              docVersionId: 'version-1',
              sha256: 'a'.repeat(64),
              chunkId: chunkId.toString(),
              locator: { kind: 'pdf-page' as const, page: 3, extractorVersion: 'v1' },
              quote: 'at a cap rate of approximately 6.10%',
            },
          ],
        },
      ],
    };
    const verificationReport = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
    };
    mockAnswerModel.create.mockResolvedValueOnce({
      _id: answerId,
      outcome,
      claimCoverage: 1,
    });

    const result = await service.persist({
      questionText: 'What is the cap rate?',
      tenantId: 'acme',
      retrievedChunkIds: [chunkId.toString()],
      outcome,
      claims: outcome.claims,
      claimCoverage: 1,
      verificationReport,
    });

    expect(mockAnswerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'acme',
        retrievedChunkIds: [chunkId],
        claimCoverage: 1,
        verificationReport,
      }),
    );
    expect(result).toEqual({
      answerId: answerId.toString(),
      outcomeKind: 'answered',
      claimCoverage: 1,
    });
  });
});
