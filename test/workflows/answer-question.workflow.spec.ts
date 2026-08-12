import { answerQuestion } from '../../src/workflows/answer-question.workflow';
import type { AnswerQuestionInput } from '../../src/workflows/types';

interface ActivityStubs {
  retrieveEvidence: jest.Mock;
  synthesizeAnswer: jest.Mock;
  groundingCheck: jest.Mock;
  persistAnswer: jest.Mock;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock;
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

const input: AnswerQuestionInput = {
  answerId: 'answer-1',
  questionText: 'What is the cap rate?',
  tenantId: 'acme-corp',
};

describe('answerQuestion', () => {
  beforeEach(() => {
    activityStubs.retrieveEvidence.mockResolvedValue([{ chunkId: 'chunk-1' }]);
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
});
