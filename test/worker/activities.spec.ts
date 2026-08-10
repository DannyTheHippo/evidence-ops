import type { INestApplicationContext } from '@nestjs/common';
import { ConflictsService } from '../../src/features/evidence/conflicts/conflicts.service';
import { FactsService } from '../../src/features/evidence/facts/facts.service';
import { IngestionService } from '../../src/features/evidence/ingestion/ingestion.service';
import { AnswerPersistenceService } from '../../src/features/evidence/qa/answer-persistence.service';
import type { Claim } from '../../src/features/evidence/qa/contracts/answer.contract';
import { EvidenceRetrievalService } from '../../src/features/evidence/qa/evidence-retrieval.service';
import { GroundingGateService } from '../../src/features/evidence/qa/grounding-gate.service';
import { SynthesisService } from '../../src/features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../../src/features/evidence/qa/types/retrieved-chunk.type';
import { createActivities } from '../../src/worker/activities';

/**
 * `app.get` resolves each service by class token regardless of call order, so a single mock
 * returning the right stub per token (rather than per call index) mirrors every other service
 * `createActivities` needs, not just the one under test in a given `it`.
 */
function buildApp(overrides: {
  ingestVersion?: jest.Mock;
  extractFacts?: jest.Mock;
  scanForConflicts?: jest.Mock;
  retrieve?: jest.Mock;
  synthesizeAnswer?: jest.Mock;
  verify?: jest.Mock;
  persist?: jest.Mock;
}): INestApplicationContext {
  const services = new Map<unknown, unknown>([
    [IngestionService, { ingestVersion: overrides.ingestVersion ?? jest.fn() }],
    [FactsService, { extractFacts: overrides.extractFacts ?? jest.fn() }],
    [ConflictsService, { scanForConflicts: overrides.scanForConflicts ?? jest.fn() }],
    [EvidenceRetrievalService, { retrieve: overrides.retrieve ?? jest.fn() }],
    [SynthesisService, { synthesizeAnswer: overrides.synthesizeAnswer ?? jest.fn() }],
    [GroundingGateService, { verify: overrides.verify ?? jest.fn() }],
    [AnswerPersistenceService, { persist: overrides.persist ?? jest.fn() }],
  ]);

  return {
    get: jest.fn((token: unknown) => services.get(token)),
  } as unknown as INestApplicationContext;
}

/** Matches `evidence-retrieval.service.spec.ts`'s fixture pattern — a real, schema-shaped value
 * rather than an `as never` cast, since `RetrievedChunk`'s fields are read by
 * `GroundingGateService.verify`/`verifyClaim`, not just passed through opaquely. */
function buildRetrievedChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: 'chunk-1',
    docVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    text: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
    ...overrides,
  };
}

/** A schema-valid `Claim`: `claimSchema.citations` requires `.min(1)`, so an `as never`-cast
 * `citations: []` (as this file previously used) smuggled an invalid `Claim` past the type
 * system — build a real citation instead. */
function buildClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    statement: 'The cap rate was approximately 6.10%.',
    citations: [
      {
        docVersionId: 'version-1',
        sha256: 'a'.repeat(64),
        chunkId: 'chunk-1',
        locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
        quote: 'a cap rate of approximately 6.10%',
      },
    ],
    ...overrides,
  };
}

describe('createActivities', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should resolve IngestionService from the given application context', () => {
    const app = buildApp({});
    // `buildApp` casts its literal through `as unknown as INestApplicationContext`, so the rule
    // sees an interface method and cannot tell this is already an arrow-bound `jest.fn()` that
    // never reads `this`. Extracting it is safe; the cast is what hides that.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- see above
    const mockGet = app.get;

    createActivities(app);

    expect(mockGet).toHaveBeenCalledWith(IngestionService);
  });

  it('should delegate ingestDocumentVersion to IngestionService.ingestVersion', async () => {
    const mockIngestVersion = jest
      .fn()
      .mockResolvedValue({ chunksCreated: 3, alreadyIngested: false });
    const app = buildApp({ ingestVersion: mockIngestVersion });

    const activities = createActivities(app);
    const result = await activities.ingestDocumentVersion('doc-1');

    expect(mockIngestVersion).toHaveBeenCalledWith('doc-1');
    expect(result).toEqual({ chunksCreated: 3, alreadyIngested: false });
  });

  it('should delegate extractFacts to FactsService.extractFacts', async () => {
    const mockExtractFacts = jest
      .fn()
      .mockResolvedValue({ factsCreated: 2, alreadyExtracted: false });
    const app = buildApp({ extractFacts: mockExtractFacts });

    const activities = createActivities(app);
    const result = await activities.extractFacts('version-1');

    expect(mockExtractFacts).toHaveBeenCalledWith('version-1');
    expect(result).toEqual({ factsCreated: 2, alreadyExtracted: false });
  });

  it('should delegate scanForConflicts to ConflictsService.scanForConflicts', async () => {
    const mockScanForConflicts = jest.fn().mockResolvedValue({ conflictsCreated: 1 });
    const app = buildApp({ scanForConflicts: mockScanForConflicts });

    const activities = createActivities(app);
    const result = await activities.scanForConflicts('acme-corp');

    expect(mockScanForConflicts).toHaveBeenCalledWith('acme-corp');
    expect(result).toEqual({ conflictsCreated: 1 });
  });

  it('should delegate retrieveEvidence to EvidenceRetrievalService.retrieve', async () => {
    const mockRetrieve = jest.fn().mockResolvedValue([{ chunkId: 'chunk-1' }]);
    const app = buildApp({ retrieve: mockRetrieve });

    const activities = createActivities(app);
    const input = { questionText: 'What is the cap rate?', tenantId: 'acme' };
    const result = await activities.retrieveEvidence(input);

    expect(mockRetrieve).toHaveBeenCalledWith(input);
    expect(result).toEqual([{ chunkId: 'chunk-1' }]);
  });

  it('should delegate synthesizeAnswer to SynthesisService.synthesizeAnswer, renaming questionText to question', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };
    const mockSynthesizeAnswer = jest.fn().mockResolvedValue(outcome);
    const app = buildApp({ synthesizeAnswer: mockSynthesizeAnswer });
    const chunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.synthesizeAnswer({
      questionText: 'What is the cap rate?',
      chunks,
    });

    expect(mockSynthesizeAnswer).toHaveBeenCalledWith({
      question: 'What is the cap rate?',
      chunks,
    });
    expect(result).toBe(outcome);
  });

  it('should skip GroundingGateService.verify and pass the outcome through unchanged for a non-answered outcome', async () => {
    const mockVerify = jest.fn();
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks: [] });

    expect(mockVerify).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome, claims: [] });
  });

  it('should call GroundingGateService.verify and build a verification report for an outcome that survives grounding as answered', async () => {
    const claim = buildClaim();
    const droppedClaim = { statement: 'dropped', reason: 'not grounded' };
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [droppedClaim],
      violations: [],
      claimCoverage: 0.5,
    });
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks });

    expect(mockVerify).toHaveBeenCalledWith({ outcome, retrievedChunks });
    expect(result).toEqual({
      outcome,
      claims: [claim],
      claimCoverage: 0.5,
      verificationReport: {
        verifiedClaimCount: 1,
        totalClaimCount: 2,
        droppedClaims: [droppedClaim],
      },
    });
  });

  it('should degrade the persisted outcome to insufficient_evidence when the gate drops every claim', async () => {
    // Regression for FIX 1: the model claimed `answered`, but zero claims survived verification
    // — the gate's degraded `outcomeKind`, not the model's raw `answered`, must be what
    // `groundingCheck` returns as `outcome`.
    const claim = buildClaim();
    const droppedClaim = { statement: claim.statement, reason: 'quote not found' };
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'insufficient_evidence',
      claims: [],
      droppedClaims: [droppedClaim],
      violations: [],
      claimCoverage: 0,
    });
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks });

    expect(result.outcome.kind).toBe('insufficient_evidence');
    if (result.outcome.kind === 'insufficient_evidence') {
      expect(result.outcome.reason.length).toBeGreaterThan(0);
    }
    expect(result.claims).toEqual([]);
    expect(result.claimCoverage).toBe(0);
    expect(result.verificationReport).toEqual({
      verifiedClaimCount: 0,
      totalClaimCount: 1,
      droppedClaims: [droppedClaim],
    });
  });

  it('should throw when the gate returns conflicting_evidence, since conflictedFactKeys is never supplied here', async () => {
    // `report.outcomeKind === 'conflicting_evidence'` is unreachable in the wired path (see
    // ADR-0004's Known bounds) because `conflictedFactKeys` is never passed to `verify` below —
    // this asserts the guard fires loudly rather than silently persisting a mismatched outcome.
    const claim = buildClaim();
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'conflicting_evidence',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
      conflictingFactKey: { entity: 'Northgate', metric: 'cap rate', period: '2025' },
    });
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);

    await expect(activities.groundingCheck({ outcome, retrievedChunks })).rejects.toThrow(
      /conflicting_evidence/,
    );
  });

  it('should delegate persistAnswer to AnswerPersistenceService.persist', async () => {
    const persistResult = {
      answerId: 'answer-1',
      outcomeKind: 'answered' as const,
      claimCoverage: 1,
    };
    const mockPersist = jest.fn().mockResolvedValue(persistResult);
    const app = buildApp({ persist: mockPersist });
    const input = {
      answerId: 'answer-1',
      questionText: 'What is the cap rate?',
      retrievedChunkIds: [],
      outcome: { kind: 'insufficient_evidence' as const, reason: 'none' },
      claims: [],
    };

    const activities = createActivities(app);
    const result = await activities.persistAnswer(input);

    expect(mockPersist).toHaveBeenCalledWith(input);
    expect(result).toBe(persistResult);
  });
});
