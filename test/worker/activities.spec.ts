import type { INestApplicationContext } from '@nestjs/common';
import { DEFAULT_TENANT_ID } from '../../src/database/constants/tenant.constant';
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
 * `createActivities` needs, not just the one under test in a given `it`. `findCellFacts` and
 * `findConflictedFactGroupsForChunks` default to resolving `[]` — the same "no grounding input"
 * shape `GroundingGateService.verify` itself defaults to — so a test that doesn't care about
 * cell facts/conflicts doesn't have to stub them.
 */
function buildApp(overrides: {
  ingestVersion?: jest.Mock;
  extractFacts?: jest.Mock;
  scanForConflicts?: jest.Mock;
  findCellFacts?: jest.Mock;
  retrieve?: jest.Mock;
  synthesizeAnswer?: jest.Mock;
  verify?: jest.Mock;
  findConflictedFactGroupsForChunks?: jest.Mock;
  persist?: jest.Mock;
}): INestApplicationContext {
  const services = new Map<unknown, unknown>([
    [IngestionService, { ingestVersion: overrides.ingestVersion ?? jest.fn() }],
    [
      FactsService,
      {
        extractFacts: overrides.extractFacts ?? jest.fn(),
        findCellFacts: overrides.findCellFacts ?? jest.fn().mockResolvedValue([]),
      },
    ],
    [
      ConflictsService,
      {
        scanForConflicts: overrides.scanForConflicts ?? jest.fn(),
        findConflictedFactGroupsForChunks:
          overrides.findConflictedFactGroupsForChunks ?? jest.fn().mockResolvedValue([]),
      },
    ],
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

    expect(mockVerify).toHaveBeenCalledWith({
      outcome,
      retrievedChunks,
      cellFacts: [],
      conflictedFactKeys: [],
    });
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

  it('should load cell facts and conflicted fact keys scoped to the retrieved chunks and tenant, and project them for GroundingGateService.verify', async () => {
    const claim = buildClaim();
    const chunk = buildRetrievedChunk({ chunkId: 'chunk-xlsx' });
    const cellFactDoc = {
      chunkId: 'chunk-xlsx',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 5.25, unit: 'percent' },
      locator: { kind: 'xlsx-cell', sheetName: 'Comps', cell: 'F2', extractorVersion: 'v1' },
    };
    const conflictedFactKey = {
      entity: 'Northgate Business Park',
      metric: 'cap_rate',
      period: '2025-03',
    };
    const mockFindCellFacts = jest.fn().mockResolvedValue([cellFactDoc]);
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([{ factKey: conflictedFactKey, values: [] }]);
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
    });
    const app = buildApp({
      findCellFacts: mockFindCellFacts,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      verify: mockVerify,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };

    const activities = createActivities(app);
    await activities.groundingCheck({ outcome, retrievedChunks: [chunk], tenantId: 'acme-corp' });

    expect(mockFindCellFacts).toHaveBeenCalledWith(['chunk-xlsx'], 'acme-corp');
    expect(mockFindConflictedFactGroupsForChunks).toHaveBeenCalledWith(['chunk-xlsx'], 'acme-corp');
    expect(mockVerify).toHaveBeenCalledWith({
      outcome,
      retrievedChunks: [chunk],
      cellFacts: [
        {
          chunkId: 'chunk-xlsx',
          factKey: cellFactDoc.factKey,
          value: cellFactDoc.value,
          locator: cellFactDoc.locator,
        },
      ],
      conflictedFactKeys: [conflictedFactKey],
    });
  });

  it('should default tenantId to the shared tenant constant when none is provided', async () => {
    const claim = buildClaim();
    const mockFindCellFacts = jest.fn().mockResolvedValue([]);
    const mockFindConflictedFactGroupsForChunks = jest.fn().mockResolvedValue([]);
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
    });
    const app = buildApp({
      findCellFacts: mockFindCellFacts,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      verify: mockVerify,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    await activities.groundingCheck({ outcome, retrievedChunks });

    expect(mockFindCellFacts).toHaveBeenCalledWith([retrievedChunks[0].chunkId], DEFAULT_TENANT_ID);
    expect(mockFindConflictedFactGroupsForChunks).toHaveBeenCalledWith(
      [retrievedChunks[0].chunkId],
      DEFAULT_TENANT_ID,
    );
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

  it('should build a conflicting_evidence outcome from the matching conflict group when the gate forces a conflict', async () => {
    const claim = buildClaim();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
    ];
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'conflicting_evidence',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
      conflictingFactKey: factKey,
    });
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([{ factKey, values }]);
    const app = buildApp({
      verify: mockVerify,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks });

    expect(result.outcome).toEqual({ kind: 'conflicting_evidence', factKey, values });
    // The survived claims themselves still come from the report, not emptied out just because the
    // outcome kind changed — `conflicting_evidence` overrides the outcome, not the claim list.
    expect(result.claims).toEqual([claim]);
  });

  it('should throw when the gate forces conflicting_evidence for a fact key with no matching conflict group', async () => {
    // Invariant guard: `conflictedFactKeys` passed to `verify` comes entirely from
    // `conflictGroups`, so a returned `conflictingFactKey` with no matching group means the two
    // have drifted out of sync — this must fail loudly, never silently mis-persist.
    const claim = buildClaim();
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'conflicting_evidence',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
      conflictingFactKey: { entity: 'Northgate', metric: 'cap_rate', period: '2025-03' },
    });
    const mockFindConflictedFactGroupsForChunks = jest.fn().mockResolvedValue([]);
    const app = buildApp({
      verify: mockVerify,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);

    await expect(activities.groundingCheck({ outcome, retrievedChunks })).rejects.toThrow(
      /no matching entry in conflictGroups/,
    );
  });

  it('should throw when the gate reports conflicting_evidence with no conflictingFactKey set', async () => {
    // Defensive guard against `GroundingReport`'s own doc comment: `outcomeKind` and
    // `conflictingFactKey` are not a discriminated union, so a caller has to check both.
    const claim = buildClaim();
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'conflicting_evidence',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
      conflictingFactKey: undefined,
    });
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);

    await expect(activities.groundingCheck({ outcome, retrievedChunks })).rejects.toThrow(
      /no conflictingFactKey set/,
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
