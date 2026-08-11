import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Answer } from '../../../../src/database/schemas/evidence/answer/answer.schema';
import { computeChunkId } from '../../../../src/features/evidence/ingestion/compute-chunk-id';
import { AnswerPersistenceService } from '../../../../src/features/evidence/qa/answer-persistence.service';
import { AnswerNotFoundException } from '../../../../src/features/evidence/qa/exceptions/qa.exception';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

// A real content-addressed chunk id (`computeChunkId`), not a hand-made `ObjectId` — 64 hex
// characters, which is not a valid `ObjectId` input (24 hex characters). Regression fixture for
// the crash `new Types.ObjectId(chunkId)` produced in `AnswerPersistenceService.persist` when
// `EvidenceChunk._id` moved off `ObjectId` (see `answer.schema.ts`'s `retrievedChunkIds` comment):
// a hand-made `ObjectId`-shaped fixture would not have caught it, since a 24-hex-char string casts
// to `ObjectId` without error.
const CHUNK_ID = computeChunkId({
  documentVersionSha256: 'a'.repeat(64),
  ordinal: 0,
  locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
});

/** A stand-in for the `AnswerDocument` `findById` resolves — mutable fields plus a `save` mock,
 * mirroring the findById-then-mutate-then-save shape `AnswerPersistenceService.persist` now uses
 * (see `DocumentsService.addVersion`'s sibling test for the same document-mock pattern). */
function buildAnswerDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    _id: new Types.ObjectId(),
    runStatus: 'queued',
    retrievedChunkIds: [],
    outcome: undefined,
    claims: [],
    claimCoverage: undefined,
    verificationReport: undefined,
    tenantId: 'default',
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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

  it('should throw AnswerNotFoundException instead of creating a new row when the queued Answer is missing', async () => {
    // Regression for the fix: a missing row must fail closed, not silently `create` a second,
    // unrelated `Answer` document under the id nobody can address — that would just reintroduce
    // the original bug (two unrelated answer rows) under a different id.
    const answerId = new Types.ObjectId().toString();
    mockAnswerModel.findById.mockResolvedValueOnce(null);

    await expect(
      service.persist({
        answerId,
        questionText: 'What is the vacancy rate?',
        retrievedChunkIds: [],
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      }),
    ).rejects.toBeInstanceOf(AnswerNotFoundException);
    expect(mockAnswerModel.create).not.toHaveBeenCalled();
  });

  it('should update the existing row to runStatus completed with default tenantId for an insufficient_evidence outcome', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'no supporting evidence' };
    const answerDoc = buildAnswerDoc();
    mockAnswerModel.findById.mockResolvedValueOnce(answerDoc);

    const result = await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the vacancy rate?',
      retrievedChunkIds: [],
      outcome,
      claims: [],
    });

    expect(mockAnswerModel.findById).toHaveBeenCalledWith(
      (answerDoc._id as Types.ObjectId).toString(),
    );
    expect(answerDoc).toMatchObject({
      runStatus: 'completed',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
      claimCoverage: undefined,
      verificationReport: undefined,
    });
    expect(answerDoc.save).toHaveBeenCalled();
    expect(result).toEqual({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      outcomeKind: 'insufficient_evidence',
      claimCoverage: undefined,
    });
  });

  it('should persist retrievedChunkIds as-is (content-addressed strings) and pass an explicit tenantId and gate fields through for an answered outcome', async () => {
    const outcome = {
      kind: 'answered' as const,
      claims: [
        {
          statement: 'The cap rate is approximately 6.10%.',
          citations: [
            {
              docVersionId: 'version-1',
              sha256: 'a'.repeat(64),
              chunkId: CHUNK_ID,
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
    const answerDoc = buildAnswerDoc();
    mockAnswerModel.findById.mockResolvedValueOnce(answerDoc);

    const result = await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the cap rate?',
      tenantId: 'acme',
      retrievedChunkIds: [CHUNK_ID],
      outcome,
      claims: outcome.claims,
      claimCoverage: 1,
      verificationReport,
    });

    // Regression: `EvidenceChunk._id` is content-addressed (`computeChunkId`), not an ObjectId —
    // `AnswerPersistenceService.persist` used to coerce this array through `new Types.ObjectId(id)`,
    // which throws `BSONError` on a 64-character sha256 hex string (only a 24-character hex string
    // is a valid `ObjectId`). Asserting the exact string round-trips confirms no such coercion runs.
    expect(answerDoc).toMatchObject({
      tenantId: 'acme',
      retrievedChunkIds: [CHUNK_ID],
      claimCoverage: 1,
      verificationReport,
    });
    expect(answerDoc.save).toHaveBeenCalled();
    expect(result).toEqual({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      outcomeKind: 'answered',
      claimCoverage: 1,
    });
  });
});
