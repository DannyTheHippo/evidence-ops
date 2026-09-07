import type { INestApplicationContext } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictsService } from '../../src/features/evidence/conflicts/conflicts.service';
import {
  CanonicalEntityService,
  type CanonicalEntityListing,
} from '../../src/features/evidence/facts/canonical-entity.service';
import { derivePeriodFromDateText } from '../../src/features/evidence/facts/derive-period';
import { FactsService } from '../../src/features/evidence/facts/facts.service';
import { METRIC_ONTOLOGY } from '../../src/features/evidence/facts/metric-ontology';
import { IngestionService } from '../../src/features/evidence/ingestion/ingestion.service';
import { MeasuresService } from '../../src/features/evidence/measures/measures.service';
import { AnswerPersistenceService } from '../../src/features/evidence/qa/answer-persistence.service';
import type { Claim } from '../../src/features/evidence/qa/contracts/answer.contract';
import { EvidenceRetrievalService } from '../../src/features/evidence/qa/evidence-retrieval.service';
import { GroundingGateService } from '../../src/features/evidence/qa/grounding-gate.service';
import { SynthesisService } from '../../src/features/evidence/qa/synthesis.service';
import type { RetrievedChunk } from '../../src/features/evidence/qa/types/retrieved-chunk.type';
import { SourcesService } from '../../src/features/evidence/sources/sources.service';
import { APPROVAL_CHANNEL } from '../../src/providers/approval-channel/approval-channel.interface';
import type { AlsContext } from '../../src/shared/types/als-context.type';
import { createActivities } from '../../src/worker/activities';
import { INGEST_HEARTBEAT_INTERVAL_MS } from '../../src/workflows/ingest-retry-policy';

/**
 * `Context.current()` resolves only inside a real activity invocation on a worker, which these
 * unit tests never enter, so the activity context is mocked — `ingestDocumentVersion` reads it
 * synchronously for its heartbeat pump and its cancellation signal. `jest.mock` is hoisted above
 * this file's imports, so the mutable state lives inside the factory and is reached through
 * `activityContext` below.
 */
jest.mock('@temporalio/activity', () => {
  const state = { heartbeat: jest.fn(), controller: new AbortController() };
  return {
    Context: {
      current: () => ({
        heartbeat: state.heartbeat,
        cancellationSignal: state.controller.signal,
      }),
    },
    __state: state,
  };
});

const activityContext = jest.requireMock('@temporalio/activity') as unknown as {
  __state: { heartbeat: jest.Mock; controller: AbortController };
};

/**
 * `app.get` resolves each service by class token regardless of call order, so a single mock
 * returning the right stub per token (rather than per call index) mirrors every other service
 * `createActivities` needs, not just the one under test in a given `it`. `findCellFacts`,
 * `findConflictedFactGroupsForChunks`, `findConflictedFactGroupsForTenant` and
 * `listCanonicalEntities` default to resolving `[]` — the same "no grounding input" shape
 * `GroundingGateService.verify` itself defaults to — so a test that doesn't care about cell
 * facts/conflicts/canonical entities doesn't have to stub them. `listConfirmedDefinitions`
 * defaults to `METRIC_ONTOLOGY` — the seed set every tenant starts confirmed with — so every
 * existing metric-naming test keeps resolving against the same vocabulary it always has.
 */
function buildApp(overrides: {
  ingestVersion?: jest.Mock;
  recordFactExtractionFailure?: jest.Mock;
  extractFacts?: jest.Mock;
  scanForConflicts?: jest.Mock;
  findCellFacts?: jest.Mock;
  listCanonicalEntities?: jest.Mock;
  listConfirmedDefinitions?: jest.Mock;
  retrieve?: jest.Mock;
  synthesizeAnswer?: jest.Mock;
  verify?: jest.Mock;
  findConflictedFactGroupsForChunks?: jest.Mock;
  findConflictedFactGroupsForTenant?: jest.Mock;
  persist?: jest.Mock;
  loadConflictForResolution?: jest.Mock;
  recordResolution?: jest.Mock;
  requestApproval?: jest.Mock;
  getDecision?: jest.Mock;
  findTenantIdForSync?: jest.Mock;
  runSync?: jest.Mock;
  als?: AsyncLocalStorage<AlsContext>;
}): INestApplicationContext {
  const services = new Map<unknown, unknown>([
    [AsyncLocalStorage, overrides.als ?? new AsyncLocalStorage<AlsContext>()],
    [
      IngestionService,
      {
        ingestVersion: overrides.ingestVersion ?? jest.fn(),
        recordFactExtractionFailure: overrides.recordFactExtractionFailure ?? jest.fn(),
      },
    ],
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
        findConflictedFactGroupsForTenant:
          overrides.findConflictedFactGroupsForTenant ?? jest.fn().mockResolvedValue([]),
        loadConflictForResolution: overrides.loadConflictForResolution ?? jest.fn(),
        recordResolution: overrides.recordResolution ?? jest.fn(),
      },
    ],
    [
      CanonicalEntityService,
      {
        listCanonicalEntities: overrides.listCanonicalEntities ?? jest.fn().mockResolvedValue([]),
      },
    ],
    [
      MeasuresService,
      {
        listConfirmedDefinitions:
          overrides.listConfirmedDefinitions ?? jest.fn().mockResolvedValue([...METRIC_ONTOLOGY]),
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
    [
      SourcesService,
      {
        findTenantIdForSync: overrides.findTenantIdForSync ?? jest.fn(),
        runSync: overrides.runSync ?? jest.fn(),
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

/** A `CanonicalEntityListing` as `CanonicalEntityService.listCanonicalEntities` returns it —
 *  `canonicalNameNormalized`/`aliasesNormalized` pre-derived, matching the normalized form
 *  `resolveQuestionEntity` (`scope-conflict-to-question.ts`) matches question text against. */
function buildCanonicalEntity(
  overrides: Partial<CanonicalEntityListing> = {},
): CanonicalEntityListing {
  return {
    canonicalName: 'Northgate Business Park',
    canonicalNameNormalized: 'northgate business park',
    aliasesNormalized: [],
    ...overrides,
  };
}

describe('createActivities', () => {
  beforeEach(() => {
    // A fresh signal per test — an abort in one test must not reach the next.
    activityContext.__state.controller = new AbortController();
  });

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
    const result = await activities.ingestDocumentVersion('doc-1', 'acme-corp');

    // The activity's own cancellation signal is threaded through as the third argument: it is what
    // lets `ingestVersion` observe an abandoned attempt and record it, instead of the version
    // sitting `pending` with a live lease until the reconciler finds it.
    expect(mockIngestVersion).toHaveBeenCalledWith(
      'doc-1',
      'acme-corp',
      activityContext.__state.controller.signal,
    );
    expect(result).toEqual({ chunksCreated: 3, alreadyIngested: false });
  });

  // A heartbeat is what keeps Temporal's `heartbeatTimeout` from firing on a healthy long ingest,
  // and the pump must not outlive the activity that owns it.
  it('should heartbeat on a timer while ingestDocumentVersion runs and clear it once the ingest settles', async () => {
    // The timer globals are restored by assignment, not by `mockRestore`/`useRealTimers`: in this
    // environment both leave `setInterval` undefined for every later test in the file.
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    try {
      const mockIngestVersion = jest
        .fn()
        .mockResolvedValue({ chunksCreated: 3, alreadyIngested: false });
      const app = buildApp({ ingestVersion: mockIngestVersion });
      const activities = createActivities(app);

      await activities.ingestDocumentVersion('doc-1', 'acme-corp');

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        INGEST_HEARTBEAT_INTERVAL_MS,
      );
      const [pump] = setIntervalSpy.mock.calls[0];
      pump();
      expect(activityContext.__state.heartbeat).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0].value);
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
  });

  it('should delegate recordFactExtractionFailure to IngestionService, returning nothing to the workflow', async () => {
    const mockRecordFactExtractionFailure = jest.fn().mockResolvedValue(true);
    const app = buildApp({ recordFactExtractionFailure: mockRecordFactExtractionFailure });

    const activities = createActivities(app);
    const result = await activities.recordFactExtractionFailure(
      'doc-1',
      'acme-corp',
      'daily spend ceiling reached',
    );

    expect(mockRecordFactExtractionFailure).toHaveBeenCalledWith(
      'doc-1',
      'acme-corp',
      'daily spend ceiling reached',
    );
    expect(result).toBeUndefined();
  });

  /**
   * `withTenantScope` (and the `requireTenantId` guard it composes) is a single helper shared by
   * every tenant-carrying activity, so exercising it through `ingestDocumentVersion` (a positional
   * `tenantId` argument) and `persistAnswer` (a `tenantId` field on an input object) covers both
   * call shapes without repeating the same assertions across every wrapped activity.
   */
  describe('tenant scoping (defence in depth)', () => {
    it('should reject an empty tenantId and do no work', async () => {
      const mockIngestVersion = jest.fn();
      const app = buildApp({ ingestVersion: mockIngestVersion });
      const activities = createActivities(app);

      await expect(activities.ingestDocumentVersion('doc-1', '')).rejects.toThrow(/no tenantId/);
      expect(mockIngestVersion).not.toHaveBeenCalled();
    });

    it('should reject a missing tenantId — the shape a workflow history recorded before the tenant requirement replays with — and do no work', async () => {
      const mockPersist = jest.fn();
      const app = buildApp({ persist: mockPersist });
      const activities = createActivities(app);
      const input = {
        answerId: 'answer-1',
        questionText: 'What is the cap rate?',
        // Replay of a pre-tenancy history: the field types as `string`, but a stale history
        // supplies no value at runtime regardless of what the type says.
        tenantId: undefined as unknown as string,
        retrievedChunkIds: [],
        outcome: { kind: 'insufficient_evidence' as const, reason: 'none' },
        claims: [],
      };

      await expect(activities.persistAnswer(input)).rejects.toThrow(/no tenantId/);
      expect(mockPersist).not.toHaveBeenCalled();
    });

    it('should mark the missing-tenant rejection as a non-retryable ApplicationFailure with a stable type', async () => {
      const app = buildApp({});
      const activities = createActivities(app);

      expect.assertions(3);
      try {
        await activities.ingestDocumentVersion('doc-1', '');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationFailure);
        expect((error as ApplicationFailure).nonRetryable).toBe(true);
        expect((error as ApplicationFailure).type).toBe('MissingTenantId');
      }
    });

    it('should run the activity inside an ALS scope reporting the given tenant, restoring tenantScopePlugin for worker-context queries', async () => {
      const als = new AsyncLocalStorage<AlsContext>();
      let observedTenant: string | undefined;
      const mockIngestVersion = jest.fn(() => {
        observedTenant = als.getStore()?.tenant;
        return Promise.resolve({ chunksCreated: 3, alreadyIngested: false });
      });
      const app = buildApp({ ingestVersion: mockIngestVersion, als });
      const activities = createActivities(app);

      await activities.ingestDocumentVersion('doc-1', 'acme-corp');

      expect(observedTenant).toBe('acme-corp');
      // The scope is scoped to this call, not leaked into the ambient context afterward.
      expect(als.getStore()).toBeUndefined();
    });
  });

  it('should delegate extractFacts to FactsService.extractFacts', async () => {
    const mockExtractFacts = jest
      .fn()
      .mockResolvedValue({ factsCreated: 2, alreadyExtracted: false });
    const app = buildApp({ extractFacts: mockExtractFacts });

    const activities = createActivities(app);
    const result = await activities.extractFacts('version-1', 'acme-corp');

    expect(mockExtractFacts).toHaveBeenCalledWith('version-1', 'acme-corp');
    expect(result).toEqual({ factsCreated: 2, alreadyExtracted: false });
  });

  it('should delegate scanForConflicts to ConflictsService.scanForConflicts, threading factKeys through', async () => {
    const mockScanForConflicts = jest.fn().mockResolvedValue({ conflictsCreated: 1 });
    const app = buildApp({ scanForConflicts: mockScanForConflicts });
    const factKeys = [{ entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' }];

    const activities = createActivities(app);
    const result = await activities.scanForConflicts('acme-corp', factKeys);

    expect(mockScanForConflicts).toHaveBeenCalledWith('acme-corp', factKeys);
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

  it('should delegate synthesizeAnswer to SynthesisService.synthesizeAnswer, renaming questionText to question and threading tenantId through', async () => {
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };
    const mockSynthesizeAnswer = jest.fn().mockResolvedValue(outcome);
    const app = buildApp({ synthesizeAnswer: mockSynthesizeAnswer });
    const chunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.synthesizeAnswer({
      questionText: 'What is the cap rate?',
      chunks,
      tenantId: 'acme-corp',
    });

    expect(mockSynthesizeAnswer).toHaveBeenCalledWith({
      question: 'What is the cap rate?',
      chunks,
      tenantId: 'acme-corp',
    });
    expect(result).toBe(outcome);
  });

  // Regression: `SynthesisService` injects no Mongoose model directly, but `MODEL_PROVIDER`
  // reserves/settles spend through `TenantSpendService`, which writes an `AuditableDocument` — so
  // this activity needs the same ALS scope every other tenant-carrying activity opens, or that
  // write's `createdBy`/`updatedBy` stamp nothing.
  it('should run synthesizeAnswer inside an ALS scope reporting the given tenant', async () => {
    const als = new AsyncLocalStorage<AlsContext>();
    let observedTenant: string | undefined;
    const mockSynthesizeAnswer = jest.fn(() => {
      observedTenant = als.getStore()?.tenant;
      return Promise.resolve({ kind: 'insufficient_evidence' as const, reason: 'none' });
    });
    const app = buildApp({ synthesizeAnswer: mockSynthesizeAnswer, als });

    const activities = createActivities(app);
    // Non-empty chunks: an empty set now short-circuits before `SynthesisService.synthesizeAnswer`
    // is ever called (see the test below), which would leave `observedTenant` unset here.
    await activities.synthesizeAnswer({
      questionText: 'What is the cap rate?',
      chunks: [buildRetrievedChunk()],
      tenantId: 'acme-corp',
    });

    expect(observedTenant).toBe('acme-corp');
    expect(als.getStore()).toBeUndefined();
  });

  it('should abstain with insufficient_evidence and never call SynthesisService.synthesizeAnswer when no chunks were retrieved', async () => {
    // Regression: zero retrieved chunks means no claim could cite anything, so the gate would
    // drop every claim and degrade to insufficient_evidence regardless of what the model returns
    // — this short-circuit must reach that outcome without spending a model call.
    const mockSynthesizeAnswer = jest.fn();
    const app = buildApp({ synthesizeAnswer: mockSynthesizeAnswer });

    const activities = createActivities(app);
    const result = await activities.synthesizeAnswer({
      questionText: 'What is the cap rate?',
      chunks: [],
      tenantId: 'acme-corp',
    });

    expect(mockSynthesizeAnswer).not.toHaveBeenCalled();
    expect(result.contract).toEqual({
      kind: 'insufficient_evidence',
      reason:
        'No evidence was retrieved for this question, so there is nothing to ground an answer in.',
    });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it('should skip GroundingGateService.verify and pass the outcome through unchanged for a non-answered outcome', async () => {
    const mockVerify = jest.fn();
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks: [],
      tenantId: 'default',
    });

    expect(mockVerify).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome, claims: [] });
  });

  // "Model hints, server verifies": the model's own `reasonCode` never decides the outcome by
  // itself — only an independently verified open conflict among the retrieved chunks' facts can
  // upgrade an abstention. These three cover the hint-matches-and-verifies path, the fail-closed
  // "hint matches but nothing verifies it" path, and the "hint doesn't even match" path — the last
  // two must never call `GroundingGateService.verify` (there are no claims to verify) and the
  // middle one proves the fail-closed guard actually *ran* the lookup rather than short-circuiting.
  it("should upgrade an insufficient_evidence outcome to conflicting_evidence when the model hints at a contradiction, the server verifies an open conflict among the retrieved chunks, and the question names that conflict group's own entity", async () => {
    const conflictId = 'conflict-1';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
    ];
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([{ conflictId, factKey, values }]);
    const mockListCanonicalEntities = jest
      .fn()
      .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]);
    const mockVerify = jest.fn();
    const app = buildApp({
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      listCanonicalEntities: mockListCanonicalEntities,
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
      questionText: 'What is the cap rate for Northgate Business Park?',
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

  // Negative control (D1/scope-conflict-to-question.ts): two conflict groups sourced from the
  // same retrieval — both legitimately reachable, e.g. from the same spreadsheet — but the
  // question names only one property's own entity. The other property's values must never attach.
  it("should attach only the conflict group whose entity the question names, never a different property's conflict group retrieved alongside it", async () => {
    const northgateGroup = {
      conflictId: 'conflict-northgate',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      values: [
        { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-northgate-xlsx' },
        { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-northgate-prose' },
      ],
    };
    const sablewoodGroup = {
      conflictId: 'conflict-sablewood',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
      values: [
        { value: 4.9, unit: 'percent', sourceChunkId: 'chunk-sablewood-xlsx' },
        { value: 5.4, unit: 'percent', sourceChunkId: 'chunk-sablewood-prose' },
      ],
    };
    const mockFindConflictedFactGroupsForChunks = jest
      .fn()
      .mockResolvedValue([northgateGroup, sablewoodGroup]);
    const mockListCanonicalEntities = jest.fn().mockResolvedValue([
      buildCanonicalEntity({
        canonicalName: 'Northgate Business Park',
        canonicalNameNormalized: 'northgate business park',
      }),
      buildCanonicalEntity({
        canonicalName: 'Sablewood Retail Court',
        canonicalNameNormalized: 'sablewood retail court',
      }),
    ]);
    const app = buildApp({
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      listCanonicalEntities: mockListCanonicalEntities,
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };
    const retrievedChunks: RetrievedChunk[] = [
      buildRetrievedChunk({ chunkId: 'chunk-northgate-xlsx' }),
      buildRetrievedChunk({ chunkId: 'chunk-sablewood-xlsx' }),
    ];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'acme-corp',
      questionText: 'What is the cap rate for Sablewood Retail Court?',
    });

    expect(result).toEqual({
      outcome: {
        kind: 'conflicting_evidence',
        factKey: sablewoodGroup.factKey,
        values: sablewoodGroup.values,
      },
      claims: [],
      conflictIds: [sablewoodGroup.conflictId],
    });
  });

  it('should leave an insufficient_evidence outcome unchanged, never attaching either conflict group, when the question names none of the retrieved properties', async () => {
    const northgateGroup = {
      conflictId: 'conflict-northgate',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      values: [{ value: 5.25, unit: 'percent', sourceChunkId: 'chunk-northgate-xlsx' }],
    };
    const sablewoodGroup = {
      conflictId: 'conflict-sablewood',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
      values: [{ value: 4.9, unit: 'percent', sourceChunkId: 'chunk-sablewood-xlsx' }],
    };
    const app = buildApp({
      findConflictedFactGroupsForChunks: jest
        .fn()
        .mockResolvedValue([northgateGroup, sablewoodGroup]),
      listCanonicalEntities: jest.fn().mockResolvedValue([
        buildCanonicalEntity({
          canonicalName: 'Northgate Business Park',
          canonicalNameNormalized: 'northgate business park',
        }),
        buildCanonicalEntity({
          canonicalName: 'Sablewood Retail Court',
          canonicalNameNormalized: 'sablewood retail court',
        }),
      ]),
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks: [buildRetrievedChunk()],
      tenantId: 'acme-corp',
      questionText: 'What is the going-in cap rate?',
    });

    expect(result).toEqual({ outcome, claims: [] });
  });

  it('should leave an insufficient_evidence outcome unchanged, never guessing between them, when the question names both retrieved properties', async () => {
    const northgateGroup = {
      conflictId: 'conflict-northgate',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      values: [{ value: 5.25, unit: 'percent', sourceChunkId: 'chunk-northgate-xlsx' }],
    };
    const sablewoodGroup = {
      conflictId: 'conflict-sablewood',
      factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' },
      values: [{ value: 4.9, unit: 'percent', sourceChunkId: 'chunk-sablewood-xlsx' }],
    };
    const app = buildApp({
      findConflictedFactGroupsForChunks: jest
        .fn()
        .mockResolvedValue([northgateGroup, sablewoodGroup]),
      listCanonicalEntities: jest.fn().mockResolvedValue([
        buildCanonicalEntity({
          canonicalName: 'Northgate Business Park',
          canonicalNameNormalized: 'northgate business park',
        }),
        buildCanonicalEntity({
          canonicalName: 'Sablewood Retail Court',
          canonicalNameNormalized: 'sablewood retail court',
        }),
      ]),
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks: [buildRetrievedChunk()],
      tenantId: 'acme-corp',
      questionText:
        'Compare the cap rate for Northgate Business Park against Sablewood Retail Court.',
    });

    expect(result).toEqual({ outcome, claims: [] });
  });

  // Regression: `questionText` is optional (a replayed pre-deploy workflow history supplies none)
  // — its absence must degrade to abstention, not a crash, even when exactly one conflict group
  // would otherwise be attachable.
  it('should leave an insufficient_evidence outcome unchanged when questionText is absent, even though exactly one conflict group is retrieved', async () => {
    const conflictId = 'conflict-1';
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [{ value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' }];
    const app = buildApp({
      findConflictedFactGroupsForChunks: jest
        .fn()
        .mockResolvedValue([{ conflictId, factKey, values }]),
      listCanonicalEntities: jest
        .fn()
        .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
    });
    const outcome = {
      kind: 'insufficient_evidence' as const,
      reason:
        'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
      reasonCode: 'retrieved_evidence_contradicts_itself' as const,
    };

    const activities = createActivities(app);
    // `questionText` deliberately omitted — the shape a pre-deploy workflow history replays with.
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks: [buildRetrievedChunk({ chunkId: 'chunk-xlsx' })],
      tenantId: 'acme-corp',
    });

    expect(result).toEqual({ outcome, claims: [] });
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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'acme-corp',
    });

    // Proves the guard actually ran the lookup rather than trusting the model's hint outright.
    expect(mockFindConflictedFactGroupsForChunks).toHaveBeenCalledWith(
      [retrievedChunks[0].chunkId],
      'acme-corp',
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
      tenantId: 'default',
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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

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

  it('should persist only the claims the gate verified, not the model raw claim set, when outcomeKind stays answered with one claim dropped', async () => {
    // Regression: the model asserted two claims and one survived. `result.outcome.claims` must be
    // the gate's survivors, matching `result.claims` — persisting `input.outcome` unchanged here
    // would carry the dropped claim's citations forward as if they were still verified.
    const survivingClaim = buildClaim();
    const droppedClaim = buildClaim({ statement: 'The vacancy rate is 4%.' });
    const droppedRecord = { statement: droppedClaim.statement, reason: 'quote did not match' };
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [survivingClaim],
      droppedClaims: [droppedRecord],
      violations: [],
      claimCoverage: 0.5,
    });
    const app = buildApp({ verify: mockVerify });
    const outcome = { kind: 'answered' as const, claims: [survivingClaim, droppedClaim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

    expect(result.outcome).toEqual({ kind: 'answered', claims: [survivingClaim] });
    expect(result.claims).toEqual([survivingClaim]);
    expect(result.verificationReport).toEqual({
      verifiedClaimCount: 1,
      totalClaimCount: 2,
      droppedClaims: [droppedRecord],
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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

    expect(result.outcome).toEqual({ kind: 'conflicting_evidence', factKey, values });
    // The survived claims themselves still come from the report, not emptied out just because the
    // outcome kind changed — `conflicting_evidence` overrides the outcome, not the claim list.
    expect(result.claims).toEqual([claim]);
    expect(result.conflictIds).toEqual([conflictId]);
  });

  // Retrieval-independent forcing: `findConflictedFactGroupsForTenant` never scopes by
  // `retrievedChunks`, so these prove the outcome no longer depends on retrieval luck or on what a
  // claim happened to cite.
  describe('retrieval-independent forcing off the question’s resolved entity and metric', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const values = [
      { value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
      { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-prose' },
    ];
    const conflictId = 'conflict-1';

    it('should force conflicting_evidence without ever calling GroundingGateService.verify, when the conflicting document was never retrieved and the model answered from unrelated evidence', async () => {
      // The question below names no period, so the group's own period must be `unstated` for the
      // force to fire. Minted through `derivePeriodFromDateText` rather than written out, so this
      // spec exercises whatever key production actually produces for a source that stated no
      // period — a change to that key that the force's filter does not follow turns this red.
      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: derivePeriodFromDateText(''),
      };
      const mockFindConflictedFactGroupsForTenant = jest
        .fn()
        .mockResolvedValue([{ conflictId, factKey, values }]);
      const mockListCanonicalEntities = jest
        .fn()
        .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]);
      const mockVerify = jest.fn();
      const app = buildApp({
        findConflictedFactGroupsForTenant: mockFindConflictedFactGroupsForTenant,
        listCanonicalEntities: mockListCanonicalEntities,
        verify: mockVerify,
      });
      const claim = buildClaim({
        statement: 'The building was constructed in 1998.',
        citations: [
          {
            docVersionId: 'version-unrelated',
            sha256: 'b'.repeat(64),
            chunkId: 'chunk-unrelated',
            locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
            quote: 'constructed in 1998',
          },
        ],
      });
      const outcome = { kind: 'answered' as const, claims: [claim] };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [buildRetrievedChunk({ chunkId: 'chunk-unrelated' })],
        tenantId: 'acme-corp',
        questionText: 'What is the cap rate for Northgate Business Park?',
      });

      expect(mockFindConflictedFactGroupsForTenant).toHaveBeenCalledWith('acme-corp');
      expect(mockVerify).not.toHaveBeenCalled();
      expect(result).toEqual({
        outcome: { kind: 'conflicting_evidence', factKey, values },
        claims: [],
        conflictIds: [conflictId],
      });
    });

    it('should force conflicting_evidence even when zero chunks were retrieved', async () => {
      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: derivePeriodFromDateText(''),
      };
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest
          .fn()
          .mockResolvedValue([{ conflictId, factKey, values }]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
      });
      const outcome = {
        kind: 'insufficient_evidence' as const,
        reason:
          'No evidence was retrieved for this question, so there is nothing to ground an answer in.',
      };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the cap rate for Northgate Business Park?',
      });

      expect(result).toEqual({
        outcome: { kind: 'conflicting_evidence', factKey, values },
        claims: [],
        conflictIds: [conflictId],
      });
    });

    it('should reach the identical outcome for two different phrasings naming the same entity and metric', async () => {
      const factKey = {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: derivePeriodFromDateText(''),
      };
      const buildActivities = () =>
        createActivities(
          buildApp({
            findConflictedFactGroupsForTenant: jest
              .fn()
              .mockResolvedValue([{ conflictId, factKey, values }]),
            listCanonicalEntities: jest
              .fn()
              .mockResolvedValue([
                buildCanonicalEntity({ canonicalName: 'Northgate Business Park' }),
              ]),
          }),
        );
      const outcome = {
        kind: 'insufficient_evidence' as const,
        reason: 'None of the retrieved evidence is relevant to this question.',
        reasonCode: 'no_relevant_evidence' as const,
      };

      const first = await buildActivities().groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the cap rate for Northgate Business Park?',
      });
      const second = await buildActivities().groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the capitalization rate for Northgate Business Park?',
      });

      expect(first.outcome.kind).toBe('conflicting_evidence');
      expect(second).toEqual(first);
    });

    it('should NOT force conflicting_evidence when the question names the entity but no recognized metric phrase', async () => {
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest
          .fn()
          .mockResolvedValue([{ conflictId, factKey, values }]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
      });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'Tell me about Northgate Business Park.',
      });

      expect(result).toEqual({ outcome, claims: [] });
    });

    it('should NOT force conflicting_evidence when the resolved entity and metric name more than one open conflict group', async () => {
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest.fn().mockResolvedValue([
          { conflictId, factKey, values },
          {
            conflictId: 'conflict-2',
            factKey: { ...factKey, period: '2025-06' },
            values: [
              { value: 5.0, unit: 'percent', sourceChunkId: 'chunk-a' },
              { value: 5.5, unit: 'percent', sourceChunkId: 'chunk-b' },
            ],
          },
        ]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
      });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the cap rate for Northgate Business Park?',
      });

      expect(result).toEqual({ outcome, claims: [] });
    });

    // Proves the metric vocabulary `resolveQuestionMetric` matches against is the *tenant's*
    // confirmed measures, not the global `METRIC_ONTOLOGY` constant: this pair only differs in
    // whether `listConfirmedDefinitions` includes `year_built`, and only the tenant that has it
    // confirmed can have a question scoped to it.
    it('should force conflicting_evidence off a tenant-specific confirmed measure named by the question', async () => {
      const yearBuiltMeasure = {
        id: 'year_built',
        label: 'Year Built',
        aliases: ['Year Built', 'year built', 'construction year'],
        valueType: 'count' as const,
        canonicalUnit: 'years',
        units: [{ id: 'years', toCanonicalFactor: 1 }],
        toleranceKind: 'absolute' as const,
        tolerance: 0,
      };
      const yearBuiltFactKey = {
        entity: 'Northgate Business Park',
        metric: 'year_built',
        period: derivePeriodFromDateText(''),
      };
      const yearBuiltValues = [
        { value: 1998, unit: 'years', sourceChunkId: 'chunk-a' },
        { value: 2001, unit: 'years', sourceChunkId: 'chunk-b' },
      ];
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest
          .fn()
          .mockResolvedValue([{ conflictId, factKey: yearBuiltFactKey, values: yearBuiltValues }]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
        listConfirmedDefinitions: jest
          .fn()
          .mockResolvedValue([...METRIC_ONTOLOGY, yearBuiltMeasure]),
      });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the Year Built for Northgate Business Park?',
      });

      expect(result).toEqual({
        outcome: {
          kind: 'conflicting_evidence',
          factKey: yearBuiltFactKey,
          values: yearBuiltValues,
        },
        claims: [],
        conflictIds: [conflictId],
      });
    });

    it("should NOT force conflicting_evidence when the named metric's slug is absent from the tenant's confirmed measures", async () => {
      const yearBuiltFactKey = {
        entity: 'Northgate Business Park',
        metric: 'year_built',
        period: derivePeriodFromDateText(''),
      };
      const yearBuiltValues = [
        { value: 1998, unit: 'years', sourceChunkId: 'chunk-a' },
        { value: 2001, unit: 'years', sourceChunkId: 'chunk-b' },
      ];
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest
          .fn()
          .mockResolvedValue([{ conflictId, factKey: yearBuiltFactKey, values: yearBuiltValues }]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
        // Default `listConfirmedDefinitions` (METRIC_ONTOLOGY) never includes `year_built` — this
        // tenant has not confirmed it, so the question cannot resolve to that metric at all.
      });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What is the Year Built for Northgate Business Park?',
      });

      expect(result).toEqual({ outcome, claims: [] });
    });

    it('should NOT force conflicting_evidence off a dated conflict group when the question does not resolve to that period', async () => {
      // Regression for the period-blind force: `factKey.period` is `'2025-03'` and the question
      // names 2019, two periods that share no calendar day — naming the group's exact entity and
      // metric is not enough.
      const app = buildApp({
        findConflictedFactGroupsForTenant: jest
          .fn()
          .mockResolvedValue([{ conflictId, factKey, values }]),
        listCanonicalEntities: jest
          .fn()
          .mockResolvedValue([buildCanonicalEntity({ canonicalName: 'Northgate Business Park' })]),
      });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const activities = createActivities(app);
      const result = await activities.groundingCheck({
        outcome,
        retrievedChunks: [],
        tenantId: 'acme-corp',
        questionText: 'What was the cap rate for Northgate Business Park in 2019?',
      });

      expect(result).toEqual({ outcome, claims: [] });
    });

    // The force is the one check in `groundingCheck` that does not depend on retrieval, and every
    // case below drives its period through the production parser rather than a written-out key, so
    // that a period model the filter stops agreeing with fails here instead of passing silently.
    describe('period matching between the question and the conflict group', () => {
      const buildDatedApp = (period: string) =>
        buildApp({
          findConflictedFactGroupsForTenant: jest
            .fn()
            .mockResolvedValue([{ conflictId, factKey: { ...factKey, period }, values }]),
          listCanonicalEntities: jest
            .fn()
            .mockResolvedValue([
              buildCanonicalEntity({ canonicalName: 'Northgate Business Park' }),
            ]),
        });
      const outcome = { kind: 'insufficient_evidence' as const, reason: 'none' };

      const force = async (period: string, questionText: string) =>
        createActivities(buildDatedApp(period)).groundingCheck({
          outcome,
          retrievedChunks: [],
          tenantId: 'acme-corp',
          questionText,
        });

      it.each([
        ['2025-03-14', 'What was the cap rate for Northgate Business Park in March 2025?'],
        ['March 12, 2025', 'What was the cap rate for Northgate Business Park in 2025-03?'],
        ['Q1 2025', 'What was the cap rate for Northgate Business Park in February 2025?'],
        ['Mar 2025', 'What was the cap rate for Northgate Business Park in 2025?'],
        ['2025', 'What was the cap rate for Northgate Business Park in March 2025?'],
      ])(
        'should force conflicting_evidence when a group dated from %p shares calendar days with the question',
        async (periodText, questionText) => {
          const period = derivePeriodFromDateText(periodText);

          const result = await force(period, questionText);

          expect(result).toEqual({
            outcome: {
              kind: 'conflicting_evidence',
              factKey: { ...factKey, period },
              values,
            },
            claims: [],
            conflictIds: [conflictId],
          });
        },
      );

      it.each([
        ['2025-03-14', 'What was the cap rate for Northgate Business Park in April 2025?'],
        ['Q1 2025', 'What was the cap rate for Northgate Business Park in Q3 2025?'],
        // A fiscal year has no calendar bounds without a tenant fiscal calendar, so it can never be
        // shown to share days with anything — including the calendar year of the same number.
        ['FY2025', 'What was the cap rate for Northgate Business Park in 2025?'],
        // The extractor handed over text stating some period that the parser refused. A question
        // naming a period must not match it, because nothing shows the two are the same period.
        ['at closing', 'What was the cap rate for Northgate Business Park in 2025?'],
      ])(
        'should NOT force conflicting_evidence when a group dated from %p shares no calendar day with the question',
        async (periodText, questionText) => {
          const result = await force(derivePeriodFromDateText(periodText), questionText);

          expect(result).toEqual({ outcome, claims: [] });
        },
      );

      it('should NOT force conflicting_evidence off a group whose period text the parser refused, when the question names no period', async () => {
        // The unstated branch must stay narrower than "has no calendar range": this source did
        // state a period, so a question that stated none has not been shown to ask about it.
        const result = await force(
          derivePeriodFromDateText('sold in 2019'),
          'What is the cap rate for Northgate Business Park?',
        );

        expect(result).toEqual({ outcome, claims: [] });
      });

      it('should NOT force conflicting_evidence when the question names more than one period', async () => {
        const result = await force(
          derivePeriodFromDateText('2025-03'),
          'How did the cap rate for Northgate Business Park move from 2019 to March 2025?',
        );

        expect(result).toEqual({ outcome, claims: [] });
      });

      it('should NOT force conflicting_evidence off a stored period key this codebase no longer writes', async () => {
        // Fails closed on an unrecognised key rather than widening it into a match — a row written
        // by another version of the period model must not be read as overlapping anything.
        const result = await force(
          'H1-2025',
          'What was the cap rate for Northgate Business Park in 2025?',
        );

        expect(result).toEqual({ outcome, claims: [] });
      });
    });
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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

    expect(result.outcome).toEqual({ kind: 'conflicting_evidence', factKey, values });
    expect(result.claims).toEqual([claim]);
    expect(result.conflictIds).toEqual([conflictId]);
  });

  // Negative control (D1/scope-conflict-to-question.ts): the claim's cited chunk and stated number
  // do match a conflict group's value, but that group belongs to a different property than the one
  // the question names — the question's own resolved entity must exclude it before the
  // cited-chunk/numeric-token match ever runs, so the widening finds nothing to force.
  it('should NOT force conflicting_evidence via either-side widening when the matching conflict group belongs to a different property than the one the question names', async () => {
    const claim = buildClaim(); // statement states 6.10; citation cites 'chunk-1'
    const sablewoodFactKey = {
      entity: 'Sablewood Retail Court',
      metric: 'cap_rate',
      period: '2025-04',
    };
    const northgateFactKey = {
      entity: 'Northgate Business Park',
      metric: 'cap_rate',
      period: '2025-03',
    };
    const mockVerify = jest.fn().mockReturnValue({
      outcomeKind: 'answered',
      claims: [claim],
      droppedClaims: [],
      violations: [],
      claimCoverage: 1,
    });
    const mockFindConflictedFactGroupsForChunks = jest.fn().mockResolvedValue([
      // Cites the claim's own chunk and states its own number — would force via the unscoped
      // match, but belongs to Sablewood, not the Northgate property the question names.
      {
        conflictId: 'conflict-sablewood',
        factKey: sablewoodFactKey,
        values: [{ value: 6.1, unit: 'percent', sourceChunkId: 'chunk-1' }],
      },
      // The question's own property — retrieved alongside the other, but has nothing on the
      // claim's cited chunk, so scoping to it finds no match either.
      {
        conflictId: 'conflict-northgate',
        factKey: northgateFactKey,
        values: [{ value: 5.25, unit: 'percent', sourceChunkId: 'chunk-northgate' }],
      },
    ]);
    const mockListCanonicalEntities = jest.fn().mockResolvedValue([
      buildCanonicalEntity({
        canonicalName: 'Sablewood Retail Court',
        canonicalNameNormalized: 'sablewood retail court',
      }),
      buildCanonicalEntity({
        canonicalName: 'Northgate Business Park',
        canonicalNameNormalized: 'northgate business park',
      }),
    ]);
    const app = buildApp({
      verify: mockVerify,
      findConflictedFactGroupsForChunks: mockFindConflictedFactGroupsForChunks,
      listCanonicalEntities: mockListCanonicalEntities,
    });
    const outcome = { kind: 'answered' as const, claims: [claim] };
    const retrievedChunks: RetrievedChunk[] = [buildRetrievedChunk()];

    const activities = createActivities(app);
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
      questionText: 'What is the cap rate for Northgate Business Park?',
    });

    expect(result.outcome).toEqual(outcome);
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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

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
    const result = await activities.groundingCheck({
      outcome,
      retrievedChunks,
      tenantId: 'default',
    });

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

    await expect(
      activities.groundingCheck({ outcome, retrievedChunks, tenantId: 'default' }),
    ).rejects.toThrow(/no matching entry in conflictGroups/);
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

    await expect(
      activities.groundingCheck({ outcome, retrievedChunks, tenantId: 'default' }),
    ).rejects.toThrow(/no conflictingFactKey set/);
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
      tenantId: 'default',
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

  it('should delegate requestIngestApproval to ApprovalChannel.requestApproval', async () => {
    const handle = { id: 'approval-2' };
    const mockRequestApproval = jest.fn().mockResolvedValue(handle);
    const app = buildApp({ requestApproval: mockRequestApproval });
    const request = {
      action: 'ingest_document_version',
      summary: "Approve ingesting 'Q3 Rent Roll' (version 'version-1')",
      subject: { entityType: 'DocumentVersion', entityId: 'version-1' },
      tenantId: 'acme-corp',
      workflowId: 'wf-ingest-1',
    };

    const activities = createActivities(app);
    const result = await activities.requestIngestApproval(request);

    expect(mockRequestApproval).toHaveBeenCalledWith(request);
    expect(result).toBe(handle);
  });

  it('should delegate getApprovalDecision to ApprovalChannel.getDecision, threading the tenant through', async () => {
    const decision = { decision: 'approved' as const, decidedBy: 'reviewer@example.com' };
    const mockGetDecision = jest.fn().mockResolvedValue(decision);
    const app = buildApp({ getDecision: mockGetDecision });

    const activities = createActivities(app);
    const result = await activities.getApprovalDecision('approval-1', 'acme-corp');

    expect(mockGetDecision).toHaveBeenCalledWith('approval-1', 'acme-corp');
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

  describe('runSourceSync', () => {
    it('should look up the tenant, run the sync inside its ALS scope, and return the result', async () => {
      const als = new AsyncLocalStorage<AlsContext>();
      let observedTenant: string | undefined;
      const syncResult = { disabled: false, intervalMs: 5000 };
      const mockFindTenantIdForSync = jest.fn().mockResolvedValue('acme-corp');
      const mockRunSync = jest.fn(() => {
        observedTenant = als.getStore()?.tenant;
        return Promise.resolve(syncResult);
      });
      const app = buildApp({
        findTenantIdForSync: mockFindTenantIdForSync,
        runSync: mockRunSync,
        als,
      });

      const activities = createActivities(app);
      const result = await activities.runSourceSync('source-1');

      expect(mockFindTenantIdForSync).toHaveBeenCalledWith('source-1');
      expect(mockRunSync).toHaveBeenCalledWith('source-1', expect.any(Types.ObjectId));
      expect(observedTenant).toBe('acme-corp');
      expect(result).toBe(syncResult);
    });

    it('should exit cleanly, without opening a scope or calling runSync, when the source no longer exists', async () => {
      const mockFindTenantIdForSync = jest.fn().mockResolvedValue(undefined);
      const mockRunSync = jest.fn();
      const app = buildApp({ findTenantIdForSync: mockFindTenantIdForSync, runSync: mockRunSync });

      const activities = createActivities(app);
      const result = await activities.runSourceSync('source-1');

      expect(mockRunSync).not.toHaveBeenCalled();
      expect(result).toEqual({ disabled: true, intervalMs: null });
    });
  });
});
