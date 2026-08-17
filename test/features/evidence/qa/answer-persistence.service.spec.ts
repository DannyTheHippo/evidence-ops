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
  tenantId: 'default',
  documentVersionSha256: 'a'.repeat(64),
  ordinal: 0,
  locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
});

/** A stand-in for the `AnswerDocument` `findOne` resolves — mutable fields plus a `save` mock,
 * mirroring the findOne-then-mutate-then-save shape `AnswerPersistenceService.persist` now uses
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
    usage: undefined,
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
        tenantId: 'default',
        retrievedChunkIds: [],
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      }),
    ).rejects.toBeInstanceOf(AnswerNotFoundException);
    expect(mockAnswerModel.create).not.toHaveBeenCalled();
  });

  it('should throw AnswerNotFoundException instead of loading the row when it belongs to another tenant', async () => {
    // Regression for the cross-tenant write primitive: a scoped lookup that misses because the
    // row belongs to a different tenant must be indistinguishable from a missing row, and must
    // never fall through to loading (and then relabeling, via `.save()`) that foreign row.
    const answerId = new Types.ObjectId().toString();
    mockAnswerModel.findOne.mockResolvedValueOnce(null);

    await expect(
      service.persist({
        answerId,
        questionText: 'What is the vacancy rate?',
        tenantId: 'acme',
        retrievedChunkIds: [],
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      }),
    ).rejects.toBeInstanceOf(AnswerNotFoundException);
    expect(mockAnswerModel.findOne).toHaveBeenCalledWith({ _id: answerId, tenantId: 'acme' });
    expect(mockAnswerModel.create).not.toHaveBeenCalled();
  });

  it('should update the existing row to runStatus completed for an insufficient_evidence outcome', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'no supporting evidence' };
    const answerDoc = buildAnswerDoc();
    mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);

    const result = await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the vacancy rate?',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
    });

    expect(mockAnswerModel.findOne).toHaveBeenCalledWith({
      _id: (answerDoc._id as Types.ObjectId).toString(),
      tenantId: 'default',
    });
    expect(answerDoc).toMatchObject({
      runStatus: 'completed',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
      claimCoverage: undefined,
      verificationReport: undefined,
      // No `conflictIds` on the input — regression for the always-`[]`-default gap: this outcome
      // is not `conflicting_evidence`, so persisting must not leave a stale array from a prior
      // attempt on the same row.
      conflictIds: [],
    });
    expect(answerDoc.save).toHaveBeenCalled();
    expect(result).toEqual({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      outcomeKind: 'insufficient_evidence',
      claimCoverage: undefined,
    });
  });

  it('should persist conflictIds as ObjectIds for a conflicting_evidence outcome', async () => {
    const conflictObjectId = new Types.ObjectId();
    const outcome = {
      kind: 'conflicting_evidence' as const,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      values: [
        { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
        { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
      ],
    };
    const answerDoc = buildAnswerDoc();
    mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);

    await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the cap rate?',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
      conflictIds: [conflictObjectId.toString()],
    });

    expect((answerDoc.conflictIds as Types.ObjectId[]).map((id) => id.toString())).toEqual([
      conflictObjectId.toString(),
    ]);
  });

  it('should persist retrievedChunkIds as-is (content-addressed strings), scope the load to the input tenant, and pass gate fields through for an answered outcome', async () => {
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
    const answerDoc = buildAnswerDoc({ tenantId: 'acme' });
    mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);

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

    expect(mockAnswerModel.findOne).toHaveBeenCalledWith({
      _id: (answerDoc._id as Types.ObjectId).toString(),
      tenantId: 'acme',
    });
    // Regression: `EvidenceChunk._id` is content-addressed (`computeChunkId`), not an ObjectId —
    // `AnswerPersistenceService.persist` used to coerce this array through `new Types.ObjectId(id)`,
    // which throws `BSONError` on a 64-character sha256 hex string (only a 24-character hex string
    // is a valid `ObjectId`). Asserting the exact string round-trips confirms no such coercion runs.
    expect(answerDoc).toMatchObject({
      // Not reassigned — the scoped `findOne` load above already guarantees the row is this
      // tenant's, so `persist` must leave `tenantId` exactly as loaded rather than writing over it.
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

  it('should persist usage when the input carries it', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'no supporting evidence' };
    const usage = { promptTokens: 875, completionTokens: 120, costUsd: 0.0234 };
    const answerDoc = buildAnswerDoc();
    mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);

    await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the cap rate?',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
      usage,
    });

    expect(answerDoc).toMatchObject({ usage });
  });

  // Regression for the retry case: an activity retry that produces no usage must clear a stale
  // value from a prior attempt, not leave it attached to a different attempt's answer — the same
  // unconditional-assign discipline `conflictIds` already follows above.
  it('should clear a previously-set usage when the input omits it', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'no supporting evidence' };
    const answerDoc = buildAnswerDoc({
      usage: { promptTokens: 500, completionTokens: 50, costUsd: 0.01 },
    });
    mockAnswerModel.findOne.mockResolvedValueOnce(answerDoc);

    await service.persist({
      answerId: (answerDoc._id as Types.ObjectId).toString(),
      questionText: 'What is the cap rate?',
      tenantId: 'default',
      retrievedChunkIds: [],
      outcome,
      claims: [],
    });

    expect(answerDoc.usage).toBeUndefined();
  });
});
