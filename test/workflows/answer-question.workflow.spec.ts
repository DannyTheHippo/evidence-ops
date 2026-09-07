import { answerQuestion } from '../../src/workflows/answer-question.workflow';
import type { AnswerQuestionInput } from '../../src/workflows/types';

interface ActivityStubs {
  retrieveEvidence: jest.Mock;
  synthesizeAnswer: jest.Mock;
  decomposeClaims: jest.Mock;
  checkContradictions: jest.Mock;
  groundingCheck: jest.Mock;
  persistAnswer: jest.Mock;
}

interface ProxyActivitiesOptions {
  readonly retry?: { readonly nonRetryableErrorTypes?: readonly string[] };
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock<unknown, [ProxyActivitiesOptions]>;
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
  };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs } = temporalWorkflowMock;

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
});
