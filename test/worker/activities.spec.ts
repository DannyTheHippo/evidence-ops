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
import { APPROVAL_CHANNEL } from '../../src/providers/approval-channel/approval-channel.interface';
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
  loadConflictForResolution?: jest.Mock;
  recordResolution?: jest.Mock;
  requestApproval?: jest.Mock;
  getDecision?: jest.Mock;
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
        loadConflictForResolution: overrides.loadConflictForResolution ?? jest.fn(),
        recordResolution: overrides.recordResolution ?? jest.fn(),
      },
    ],
    [EvidenceRetrievalService, { retrieve: overrides.retrieve ?? jest.fn() }],
    [SynthesisService, { synthesizeAnswer: overrides.synthesizeAnswer ?? jest.fn() }],
    [GroundingGateService, { verify: overrides.verify ?? jest.fn() }],
    [AnswerPersistenceService, { persist: overrides.persist ?? jest.fn() }],
    [
      APPROVAL_CHANNEL,
      {
        requestApproval: overrides.requestApproval ?? jest.fn(),
        getDecision: overrides.getDecision ?? jest.fn(),
      },
    ],
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

  // "Model hints, server verifies": the model's own `reasonCode` never decides the outcome by
  // itself — only an independently verified open conflict among the retrieved chunks' facts can
  // upgrade an abstention. These three cover the hint-matches-and-verifies path, the fail-closed
  // "hint matches but nothing verifies it" path, and the "hint doesn't even match" path — the last
  // two must never call `GroundingGateService.verify` (there are no claims to verify) and the
  // middle one proves the fail-closed guard actually *ran* the lookup rather than short-circuiting.
  it('should upgrade an insufficient_evidence outcome to conflicting_evidence when the model hints at a contradiction and the server verifies an open conflict among the retrieved chunks', async () => {
    const conflictId = 'conflict-1';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
    ];
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([{ conflictId, factKey, values }]);
    const mockVerify = jest.fn();
    const app = buildApp({
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      verify: mockVerify,
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };
    const retrievedChunks: RetrievedChunk[] = [
      buildRetrievedChunk({ chunkId: 'chunk-xlsx' }),
      buildRetrievedChunk({ chunkId: 'chunk-prose' }),
    ];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'acme-corp',
    });

    expect(mockFindConflictedFactGroupsForChunks).toHaveBeenCalledWith(
      ['chunk-xlsx', 'chunk-prose'],
      'acme-corp',
    );
    expect(mockVerify).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: { kind: 'conflicting_evidence', factKey, values },
      claims: [],
      conflictIds: [conflictId],
    });
  });

  it('should leave an insufficient_evidence outcome unchanged when the model hints at a contradiction but no conflict is verified among the retrieved chunks (fail closed)', async () => {
    const mockFindConflictedFactGroupsForChunks = jest.fn().mockResolvedValue([]);
    const app = buildApp({
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks });

    // Proves the guard actually ran the lookup rather than trusting the model's hint outright.
    expect(mockFindConflictedFactGroupsForChunks).toHaveBeenCalledWith(
      [retrievedChunks[0].chunkId],
      DEFAULT_TENANT_ID,
    );
    expect(result).toEqual({ outcome, claims: [] });
  });

  it('should leave an insufficient_evidence outcome unchanged, and never query for conflicts, when the reasonCode does not hint at a contradiction', async () => {
    const mockFindConflictedFactGroupsForChunks = jest.fn().mockResolvedValue([
      {
        factKey: { entity: 'Some Property', metric: 'cap_rate', period: '2025-03' },
        values: [],
      },
    ]);
    const app = buildApp({
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason: 'None of the retrieved evidence is relevant to this question.',
      reasonCode: 'no_relevant_evidence' as const,
    };

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks: [buildRetrievedChunk()],
    });

    expect(mockFindConflictedFactGroupsForChunks).not.toHaveBeenCalled();
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
    const conflictId = 'conflict-1';
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
      .mockResolvedValue([{ conflictId, factKey, values }]);
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
    expect(result.conflictIds).toEqual([conflictId]);
  });

  // Either-side widening (ADR-0004, sub-decision): the gate's own forcing above only ever fires
  // from `cellFacts` (xlsx-cell-only), so a surviving claim that cites a non-xlsx (e.g. prose)
  // chunk stating a conflicted value never reached `conflicting_evidence` before this widening.
  it('should force conflicting_evidence via either-side widening when a surviving claim cites a non-xlsx chunk that states a conflicted value', async () => {
    const claim = buildClaim(); // statement states 6.10; citation cites 'chunk-1'
    const conflictId = 'conflict-1';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-1' },
      { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
    ];
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
    });
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([{ conflictId, factKey, values }]);
    const app = buildApp({
      verify: mockVerify,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({ outcome, retrievedChunks });

    expect(result.outcome).toEqual({ kind: 'conflicting_evidence', factKey, values });
    expect(result.claims).toEqual([claim]);
    expect(result.conflictIds).toEqual([conflictId]);
  });

  it('should NOT force conflicting_evidence via either-side widening when the surviving claim cites a different chunk than the conflicted value it states', async () => {
    const claim = buildClaim(); // statement states 6.10; citation cites 'chunk-1'
    const factKey = { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' };
    const values = [
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-other' },
      { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
    ];
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
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

    expect(result.outcome).toEqual(outcome);
  });

  // Contamination-direction regression: `findEitherSideConflict` requires BOTH
  // `citedChunkIds.has(value.sourceChunkId)` AND `claimedNumbers.includes(value.value)` before
  // forcing — this proves the value half independently of the chunk half the test above proves.
  // Here the claim cites exactly the chunk a conflicted value lives on ('chunk-1'), but states a
  // different number (6.10) than that value (4.25) — citing the right chunk must not be enough on
  // its own, or a claim would get force-flagged as conflicting merely for citing a chunk that also
  // happens to hold an unrelated conflicted fact.
  it('should NOT force conflicting_evidence via either-side widening when the surviving claim cites the conflicted chunk but states a different number', async () => {
    const claim = buildClaim(); // statement states 6.10; citation cites 'chunk-1'
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 4.25, unit: 'percent', sourceChunkId: 'chunk-1' },
      { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
    ];
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
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

    expect(result.outcome).toEqual(outcome);
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

  it('should delegate loadConflict to ConflictsService.loadConflictForResolution, positionally', async () => {
    const candidate = {
      conflictId: 'conflict-1',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      winningFactId: 'fact-xlsx',
      values: [
        { factId: 'fact-xlsx', value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
        { factId: 'fact-pdf', value: 6.1, unit: 'percent', sourceChunkId: 'chunk-pdf' },
      ],
    };
    const mockLoadConflictForResolution = jest.fn().mockResolvedValue(candidate);
    const app = buildApp({ loadConflictForResolution: mockLoadConflictForResolution });

    const activities = createActivities(app);
    const result = await activities.loadConflict({
      conflictId: 'conflict-1',
      winningFactId: 'fact-xlsx',
      tenantId: 'acme-corp',
    });

    expect(mockLoadConflictForResolution).toHaveBeenCalledWith(
      'conflict-1',
      'fact-xlsx',
      'acme-corp',
    );
    expect(result).toBe(candidate);
  });

  it('should delegate requestConflictApproval to ApprovalChannel.requestApproval', async () => {
    const handle = { id: 'approval-1' };
    const mockRequestApproval = jest.fn().mockResolvedValue(handle);
    const app = buildApp({ requestApproval: mockRequestApproval });
    const request = {
      action: 'resolve_conflict',
      summary: 'Resolve cap_rate in favor of 5.25%',
      subject: { entityType: 'Conflict', entityId: 'conflict-1' },
      tenantId: 'acme-corp',
    };

    const activities = createActivities(app);
    const result = await activities.requestConflictApproval(request);

    expect(mockRequestApproval).toHaveBeenCalledWith(request);
    expect(result).toBe(handle);
  });

  it('should delegate getApprovalDecision to ApprovalChannel.getDecision', async () => {
    const decision = { decision: 'approved' as const, decidedBy: 'reviewer@example.com' };
    const mockGetDecision = jest.fn().mockResolvedValue(decision);
    const app = buildApp({ getDecision: mockGetDecision });

    const activities = createActivities(app);
    const result = await activities.getApprovalDecision('approval-1');

    expect(mockGetDecision).toHaveBeenCalledWith('approval-1');
    expect(result).toBe(decision);
  });

  it('should delegate recordConflictResolution to ConflictsService.recordResolution', async () => {
    const resolutionResult = { conflictId: 'conflict-1', outcome: 'resolved' as const };
    const mockRecordResolution = jest.fn().mockResolvedValue(resolutionResult);
    const app = buildApp({ recordResolution: mockRecordResolution });
    const input = {
      conflictId: 'conflict-1',
      outcome: 'resolved' as const,
      winningFactId: 'fact-xlsx',
      decidedBy: 'reviewer@example.com',
      tenantId: 'acme-corp',
    };

    const activities = createActivities(app);
    const result = await activities.recordConflictResolution(input);

    expect(mockRecordResolution).toHaveBeenCalledWith(input);
    expect(result).toBe(resolutionResult);
  });
});
