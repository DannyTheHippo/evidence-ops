import {
  CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS,
  DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS,
  SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS,
} from '../../src/workflows/activity-heartbeat-policy';
import { answerQuestion } from '../../src/workflows/answer-question.workflow';
import { INGEST_HEARTBEAT_TIMEOUT_MS } from '../../src/workflows/ingest-retry-policy';
import type { AnswerQuestionInput } from '../../src/workflows/types';

interface ActivityStubs {
  retrieveEvidence: jest.Mock;
  synthesizeAnswer: jest.Mock;
  decomposeClaims: jest.Mock;
  checkContradictions: jest.Mock;
  groundingCheck: jest.Mock;
  persistAnswer: jest.Mock;
  resolveFromLedger: jest.Mock;
}

interface ProxyActivitiesOptions {
  readonly startToCloseTimeout?: number | string;
  readonly heartbeatTimeout?: number | string;
  readonly retry?: { readonly nonRetryableErrorTypes?: readonly string[] };
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock<unknown, [ProxyActivitiesOptions]>;
  log: { warn: jest.Mock; info: jest.Mock };
}

/**
 * Same mocking approach `ingest-document-version.workflow.spec.ts` uses (see that file's own
 * top-of-file comment): no `@temporalio/testing` package is installed, so the SDK itself is
 * mocked rather than actually run. `jest.mock` is hoisted above this file's own imports
 * (including the `answerQuestion` import above, whose module-level `proxyActivities` calls run
 * against this mock), so `activityStubs` is declared inside the factory.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = {
    retrieveEvidence: jest.fn(),
    synthesizeAnswer: jest.fn(),
    decomposeClaims: jest.fn(),
    checkContradictions: jest.fn(),
    groundingCheck: jest.fn(),
    persistAnswer: jest.fn(),
    resolveFromLedger: jest.fn(),
  };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    log: { warn: jest.fn(), info: jest.fn() },
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs, log } = temporalWorkflowMock;

// Captured once, right after the workflow module's own top-level `proxyActivities` calls run
// (during the `answerQuestion` import above) and before any `afterEach(jest.resetAllMocks)`
// wipes `proxyActivities.mock.calls` — a later `describe` block reading `.mock.calls` directly
// would see an empty array once the first spec's cleanup has run. Order matches the source file's
// declaration order: retrieval, synthesis, decomposition, contradiction, grounding, persist.
const proxyActivitiesCalls = [...temporalWorkflowMock.proxyActivities.mock.calls];

const input: AnswerQuestionInput = {
  answerId: 'answer-1',
  questionText: 'What is the cap rate?',
  tenantId: 'acme-corp',
};

describe('answerQuestion', () => {
  beforeEach(() => {
    activityStubs.resolveFromLedger.mockResolvedValue({ kind: 'unresolved', reason: 'no-entity' });
    activityStubs.retrieveEvidence.mockResolvedValue([{ chunkId: 'chunk-1' }]);
    activityStubs.decomposeClaims.mockResolvedValue({ atoms: [] });
    activityStubs.checkContradictions.mockResolvedValue({ contradictedClaimIndexes: [] });
    activityStubs.groundingCheck.mockResolvedValue({
      outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
      claims: [],
    });
    activityStubs.persistAnswer.mockResolvedValue({
      answerId: 'answer-1',
      outcomeKind: 'insufficient_evidence',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // The load-bearing assertion for this step: `usage` comes back on `synthesizeAnswer`'s widened
  // `{ contract, usage }` result and must reach `persistAnswer`'s input unchanged — not the
  // model's raw `contract`, which goes to `groundingCheck` instead (see the workflow's own
  // `grounding.outcome` doc comment for why persistence reads the gate-verified outcome, not
  // synthesis's raw one).
  it('should thread the usage synthesizeAnswer returns through to persistAnswer', async () => {
    const usage = { promptTokens: 875, completionTokens: 120, costUsd: 0.0234 };
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'insufficient_evidence', reason: 'none' },
      usage,
    });

    await answerQuestion(input);

    expect(activityStubs.persistAnswer).toHaveBeenCalledWith(expect.objectContaining({ usage }));
  });

  it("should pass synthesizeAnswer's contract, not its usage, to groundingCheck as the outcome", async () => {
    const contract = { kind: 'insufficient_evidence' as const, reason: 'none' };
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract,
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });

    await answerQuestion(input);

    expect(activityStubs.groundingCheck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: contract }),
    );
  });

  // `SpendGuardModelProvider` refuses fail-closed on a `ModelRequest` with no `tenantId` — this is
  // the workflow-side link in that chain, and an omission here reaches the model provider silently
  // (the field is optional at the type level).
  it("should pass the workflow's tenantId through to synthesizeAnswer", async () => {
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'insufficient_evidence', reason: 'none' },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });

    await answerQuestion(input);

    expect(activityStubs.synthesizeAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'acme-corp' }),
    );
  });

  it('should call decomposeClaims after synthesizeAnswer and before checkContradictions and groundingCheck', async () => {
    const callOrder: string[] = [];
    activityStubs.synthesizeAnswer.mockImplementation(() => {
      callOrder.push('synthesizeAnswer');
      return Promise.resolve({
        contract: { kind: 'insufficient_evidence', reason: 'none' },
        usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
      });
    });
    activityStubs.decomposeClaims.mockImplementation(() => {
      callOrder.push('decomposeClaims');
      return Promise.resolve({ atoms: [] });
    });
    activityStubs.checkContradictions.mockImplementation(() => {
      callOrder.push('checkContradictions');
      return Promise.resolve({ contradictedClaimIndexes: [] });
    });
    activityStubs.groundingCheck.mockImplementation(() => {
      callOrder.push('groundingCheck');
      return Promise.resolve({
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      });
    });

    await answerQuestion(input);

    expect(callOrder).toEqual([
      'synthesizeAnswer',
      'decomposeClaims',
      'checkContradictions',
      'groundingCheck',
    ]);
  });

  it("should pass decomposeClaims' atoms into checkContradictions alongside the retrieved chunks", async () => {
    const atoms = [{ claimIndex: 0, statement: 'The cap rate was 6.1%.', atoms: ['atom-1'] }];
    activityStubs.decomposeClaims.mockResolvedValue({ atoms });
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'answered', claims: [] },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });

    await answerQuestion(input);

    expect(activityStubs.checkContradictions).toHaveBeenCalledWith(
      expect.objectContaining({ atoms, retrievedChunks: [{ chunkId: 'chunk-1' }] }),
    );
  });

  it("should forward decomposeClaims' atoms and checkContradictions' contradictedClaimIndexes into groundingCheck", async () => {
    const atoms = [{ claimIndex: 0, statement: 'The cap rate was 6.1%.', atoms: ['atom-1'] }];
    const contradictedClaimIndexes = [0];
    activityStubs.decomposeClaims.mockResolvedValue({ atoms });
    activityStubs.checkContradictions.mockResolvedValue({ contradictedClaimIndexes });
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'answered', claims: [] },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });

    await answerQuestion(input);

    expect(activityStubs.groundingCheck).toHaveBeenCalledWith(
      expect.objectContaining({ atoms, contradictedClaimIndexes }),
    );
  });

  it("should pass groundingCheck's atoms through to persistAnswer", async () => {
    const atoms = [{ claimIndex: 0, statement: 'The cap rate was 6.1%.', atoms: ['atom-1'] }];
    activityStubs.groundingCheck.mockResolvedValue({
      outcome: { kind: 'answered', claims: [] },
      claims: [],
      atoms,
    });
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'answered', claims: [] },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });

    await answerQuestion(input);

    expect(activityStubs.persistAnswer).toHaveBeenCalledWith(expect.objectContaining({ atoms }));
  });
});

describe('answerQuestion retrieval', () => {
  beforeEach(() => {
    activityStubs.resolveFromLedger.mockResolvedValue({ kind: 'unresolved', reason: 'no-entity' });
    activityStubs.retrieveEvidence.mockResolvedValue([{ chunkId: 'chunk-1' }]);
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'insufficient_evidence', reason: 'none' },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });
    activityStubs.decomposeClaims.mockResolvedValue({ atoms: [] });
    activityStubs.checkContradictions.mockResolvedValue({ contradictedClaimIndexes: [] });
    activityStubs.groundingCheck.mockResolvedValue({
      outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
      claims: [],
    });
    activityStubs.persistAnswer.mockResolvedValue({
      answerId: 'answer-1',
      outcomeKind: 'insufficient_evidence',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should call retrieveEvidence and pass its chunks through to synthesizeAnswer unchanged', async () => {
    await answerQuestion(input);

    expect(activityStubs.retrieveEvidence).toHaveBeenCalledWith({
      questionText: input.questionText,
      tenantId: input.tenantId,
    });
    expect(activityStubs.synthesizeAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [{ chunkId: 'chunk-1' }] }),
    );
  });
});

describe('proxyActivities retry configuration', () => {
  // Guards each group's `nonRetryableErrorTypes` against a silent rename of the error class it
  // names — Temporal matches these as plain strings (see the workflow file's own group comments),
  // so a rename that isn't mirrored here would disable the classification without failing tsc.
  it("should mark a missing tenantId and Voyage's deterministic failures non-retryable for retrieveEvidence", () => {
    const [retrievalOptions] = proxyActivitiesCalls[0];
    expect(retrievalOptions.retry?.nonRetryableErrorTypes).toEqual([
      'MissingTenantId',
      'VoyageApiKeyMissingError',
      'VoyageInvalidResponseError',
    ]);
  });

  it('should mark the budget, pricing, schema-validation, truncation, and spend-guard failures non-retryable for synthesizeAnswer', () => {
    const [synthesisOptions] = proxyActivitiesCalls[1];
    expect(synthesisOptions.retry?.nonRetryableErrorTypes).toEqual([
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ]);
  });

  it("should mark the budget, pricing, schema-validation, truncation, and spend-guard failures non-retryable for decomposeClaims, matching synthesizeAnswer's set", () => {
    const [decompositionOptions] = proxyActivitiesCalls[2];
    expect(decompositionOptions.retry?.nonRetryableErrorTypes).toEqual([
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ]);
  });

  it("should mark the budget, pricing, schema-validation, truncation, and spend-guard failures non-retryable for checkContradictions, matching synthesizeAnswer's set", () => {
    const [contradictionOptions] = proxyActivitiesCalls[3];
    expect(contradictionOptions.retry?.nonRetryableErrorTypes).toEqual([
      'ModelBudgetExceededError',
      'UnknownModelPricingError',
      'ModelSchemaValidationError',
      'ModelOutputTruncatedError',
      'TenantSpendLimitExceededError',
      'ModelRequestMissingTenantError',
    ]);
  });

  it('should mark a missing tenantId non-retryable for groundingCheck', () => {
    const [groundingOptions] = proxyActivitiesCalls[4];
    expect(groundingOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for persistAnswer', () => {
    const [persistOptions] = proxyActivitiesCalls[5];
    expect(persistOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  it('should mark a missing tenantId non-retryable for resolveFromLedger', () => {
    const [ledgerOptions] = proxyActivitiesCalls[6];
    expect(ledgerOptions.retry?.nonRetryableErrorTypes).toEqual(['MissingTenantId']);
  });

  // The three model-calling groups each budget longer than the heartbeat timeout, so each must
  // declare one — a group that runs past `heartbeatTimeout` without pumping is failed by Temporal
  // as unresponsive while it is in fact working.
  it.each<[string, number, number]>([
    ['synthesis', 1, SYNTHESIZE_ANSWER_START_TO_CLOSE_TIMEOUT_MS],
    ['decomposition', 2, DECOMPOSE_CLAIMS_START_TO_CLOSE_TIMEOUT_MS],
    ['contradiction', 3, CHECK_CONTRADICTIONS_START_TO_CLOSE_TIMEOUT_MS],
  ])(
    'should declare a heartbeat timeout for the %s group, under its startToCloseTimeout',
    (_name, index, expectedStartToClose) => {
      const [options] = proxyActivitiesCalls[index];
      expect(options.startToCloseTimeout).toBe(expectedStartToClose);
      expect(options.heartbeatTimeout).toBe(INGEST_HEARTBEAT_TIMEOUT_MS);
    },
  );

  // The property every group in this file must hold, not just the three named above: a numeric
  // `startToCloseTimeout` strictly greater than `INGEST_HEARTBEAT_TIMEOUT_MS` must declare a
  // `heartbeatTimeout`, and a group that still expresses its budget as a Temporal duration string
  // must keep that budget at or under the heartbeat timeout — the shape the cheap, pure-Mongo
  // groups in this workflow use. Stated as a sweep so a group added later is covered on arrival.
  it('should keep every captured proxyActivities group consistent with the heartbeat-timeout property', () => {
    const durationPattern = /^(\d+) (seconds?|minutes?)$/;
    for (const [options] of proxyActivitiesCalls) {
      const { startToCloseTimeout, heartbeatTimeout } = options;
      if (typeof startToCloseTimeout === 'number') {
        if (startToCloseTimeout > INGEST_HEARTBEAT_TIMEOUT_MS) {
          expect(heartbeatTimeout).toBeDefined();
        }
        continue;
      }
      const match = durationPattern.exec(startToCloseTimeout ?? '');
      expect(match).not.toBeNull();
      const [, amount, unit] = match as RegExpExecArray;
      const ms = Number(amount) * (unit.startsWith('minute') ? 60_000 : 1_000);
      expect(ms).toBeLessThanOrEqual(INGEST_HEARTBEAT_TIMEOUT_MS);
    }
  });
});

describe('answerQuestion ledger-first branch', () => {
  beforeEach(() => {
    activityStubs.resolveFromLedger.mockResolvedValue({ kind: 'unresolved', reason: 'no-entity' });
    activityStubs.retrieveEvidence.mockResolvedValue([{ chunkId: 'chunk-1' }]);
    activityStubs.synthesizeAnswer.mockResolvedValue({
      contract: { kind: 'insufficient_evidence', reason: 'none' },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 },
    });
    activityStubs.decomposeClaims.mockResolvedValue({ atoms: [] });
    activityStubs.checkContradictions.mockResolvedValue({ contradictedClaimIndexes: [] });
    activityStubs.groundingCheck.mockResolvedValue({
      outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
      claims: [],
    });
    activityStubs.persistAnswer.mockResolvedValue({
      answerId: 'answer-1',
      outcomeKind: 'insufficient_evidence',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should skip retrieveEvidence and synthesizeAnswer and persist answerPath ledger with zero usage and the ledger chunk ids, when the ledger resolves and the gate verifies it', async () => {
    const claim = {
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
    };
    const ledgerOutcome = {
      kind: 'answered' as const,
      claims: [claim],
      ledger: {
        entity: 'Northgate Business Park',
        measure: 'cap_rate',
        state: 'single' as const,
        factId: 'fact-1',
      },
    };
    const ledgerChunk = {
      chunkId: 'chunk-1',
      docVersionId: 'version-1',
      sha256: 'a'.repeat(64),
      text: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
      locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
      documentId: 'doc-1',
    };
    activityStubs.resolveFromLedger.mockResolvedValue({
      kind: 'resolved',
      outcome: ledgerOutcome,
      retrievedChunks: [ledgerChunk],
    });
    activityStubs.groundingCheck.mockResolvedValue({
      outcome: ledgerOutcome,
      claims: [claim],
      claimCoverage: 1,
    });
    activityStubs.persistAnswer.mockResolvedValue({
      answerId: 'answer-1',
      outcomeKind: 'answered',
      claimCoverage: 1,
    });

    const result = await answerQuestion(input);

    expect(activityStubs.retrieveEvidence).not.toHaveBeenCalled();
    expect(activityStubs.synthesizeAnswer).not.toHaveBeenCalled();
    expect(activityStubs.groundingCheck).toHaveBeenCalledWith({
      outcome: ledgerOutcome,
      retrievedChunks: [ledgerChunk],
      tenantId: input.tenantId,
      questionText: input.questionText,
    });
    expect(activityStubs.persistAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        answerPath: 'ledger',
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        retrievedChunkIds: ['chunk-1'],
        outcome: ledgerOutcome,
      }),
    );
    expect(result).toEqual({ answerId: 'answer-1', outcomeKind: 'answered', claimCoverage: 1 });
  });

  it('should log a warning and fall through to synthesis, persisting answerPath synthesis, when the gate degrades a resolved ledger claim to insufficient_evidence', async () => {
    const ledgerOutcome = { kind: 'answered' as const, claims: [] };
    activityStubs.resolveFromLedger.mockResolvedValue({
      kind: 'resolved',
      outcome: ledgerOutcome,
      retrievedChunks: [],
    });
    // First groundingCheck call belongs to the ledger branch, the second to the synthesis
    // fallback it triggers.
    activityStubs.groundingCheck
      .mockResolvedValueOnce({
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'grounding gate verified 0 of 1 claim(s); every citation failed verification',
        },
        claims: [],
      })
      .mockResolvedValueOnce({
        outcome: { kind: 'insufficient_evidence', reason: 'no supporting evidence' },
        claims: [],
      });

    await answerQuestion(input);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('grounding gate'),
      expect.objectContaining({ answerId: input.answerId, tenantId: input.tenantId }),
    );
    expect(activityStubs.retrieveEvidence).toHaveBeenCalled();
    expect(activityStubs.synthesizeAnswer).toHaveBeenCalled();
    expect(activityStubs.persistAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ answerPath: 'synthesis' }),
    );
  });

  it('should thread conflictIds from the ledger result into persistAnswer when the gate passes a conflicting_evidence ledger outcome through unchanged', async () => {
    const conflictingOutcome = {
      kind: 'conflicting_evidence' as const,
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      values: [
        { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-1' },
        { value: 6.4, unit: 'percent', sourceChunkId: 'chunk-2' },
      ],
    };
    activityStubs.resolveFromLedger.mockResolvedValue({
      kind: 'resolved',
      outcome: conflictingOutcome,
      retrievedChunks: [],
      conflictIds: ['conflict-1'],
    });
    // `groundingCheck` passes a non-answered outcome through unchanged (see that activity's own
    // doc comment in `activities.ts`), so it reports no `conflictIds` of its own here — the
    // workflow falls back to the ledger result's.
    activityStubs.groundingCheck.mockResolvedValue({ outcome: conflictingOutcome, claims: [] });

    await answerQuestion(input);

    expect(activityStubs.persistAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ conflictIds: ['conflict-1'], answerPath: 'ledger' }),
    );
  });
});
