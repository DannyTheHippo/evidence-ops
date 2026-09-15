import { resolveConflict } from '../../src/workflows/resolve-conflict.workflow';
import type { ResolveConflictWorkflowInput } from '../../src/workflows/types';

interface ActivityStubs {
  loadConflict: jest.Mock;
  requestConflictApproval: jest.Mock;
  getApprovalDecision: jest.Mock;
  expireApproval: jest.Mock;
  recordConflictResolution: jest.Mock;
  recordWorkflowRunEnd: jest.Mock;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  setHandler: jest.Mock;
  condition: jest.Mock;
  workflowInfo: jest.Mock;
}

type SignalHandler = (payload?: { claimedDecision?: 'approved' | 'rejected' }) => void;

/**
 * `@temporalio/workflow` only runs inside Temporal's V8 isolate (no `@temporalio/testing` package
 * is installed — its time-skipping test server needs a socket bind/binary download this sandbox
 * blocks anyway, and this repo adds no dependency it doesn't need), so `resolveConflict`'s
 * branching is exercised here by mocking the SDK itself rather than by actually running the
 * workflow engine. `jest.mock` is hoisted above this file's own imports (including the
 * `resolveConflict` import above, whose module-level `proxyActivities`/`defineSignal` calls run
 * against this mock as a result) — `activityStubs` is declared inside the factory, not captured
 * from outer scope, because a factory can only safely reference values created inside itself.
 * Exposed as a plain field (not a separate `jest.mock`-only export) so the test body can reach the
 * same object instance every `proxyActivities()` call returns.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = {
    loadConflict: jest.fn(),
    requestConflictApproval: jest.fn(),
    getApprovalDecision: jest.fn(),
    expireApproval: jest.fn(),
    recordConflictResolution: jest.fn(),
    recordWorkflowRunEnd: jest.fn(),
  };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    defineSignal: jest.fn((name: string) => ({ name })),
    setHandler: jest.fn(),
    condition: jest.fn(),
    workflowInfo: jest.fn(() => ({ workflowId: 'wf-1' })),
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs, setHandler, condition, workflowInfo } = temporalWorkflowMock;

const candidate = {
  conflictId: 'conflict-1',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  winningFactId: 'fact-xlsx',
  values: [
    { factId: 'fact-xlsx', value: 5.25, unit: 'percent', sourceChunkId: 'chunk-xlsx' },
    { factId: 'fact-pdf', value: 6.1, unit: 'percent', sourceChunkId: 'chunk-pdf' },
  ],
};

const input: ResolveConflictWorkflowInput = {
  conflictId: 'conflict-1',
  winningFactId: 'fact-xlsx',
  requestedBy: 'reviewer@example.com',
  tenantId: 'acme-corp',
  ruleFired: 'authority',
  proposedWinnerFactId: 'fact-xlsx',
};

let capturedHandler: SignalHandler | undefined;

describe('resolveConflict', () => {
  beforeEach(() => {
    capturedHandler = undefined;
    setHandler.mockImplementation((_def: unknown, handler: SignalHandler) => {
      capturedHandler = handler;
    });
    activityStubs.loadConflict.mockResolvedValue(candidate);
    activityStubs.requestConflictApproval.mockResolvedValue({ id: 'approval-1' });
    // `resetAllMocks()` below wipes `jest.mock`'s factory-time implementation every test — must be
    // re-set here (`jest-tests.md`'s own convention for a `jest.fn` carrying an implementation).
    workflowInfo.mockReturnValue({ workflowId: 'wf-1' });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should resolve and record the winner when a signal wakes it and the persisted decision is approved', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      // Simulates a signal arriving mid-wait — the handler is the real one `resolveConflict`
      // registered via `setHandler`, so invoking it flips the workflow's own `signaled` closure
      // variable, exactly as a real Temporal signal delivery would.
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({
      decision: 'approved',
      decidedBy: 'reviewer@example.com',
    });
    activityStubs.recordConflictResolution.mockResolvedValue({
      conflictId: 'conflict-1',
      outcome: 'resolved',
    });

    const result = await resolveConflict(input);

    expect(activityStubs.loadConflict).toHaveBeenCalledWith({
      conflictId: 'conflict-1',
      winningFactId: 'fact-xlsx',
      tenantId: 'acme-corp',
    });
    expect(activityStubs.requestConflictApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'resolve_conflict',
        subject: { entityType: 'Conflict', entityId: 'conflict-1' },
        requestedBy: 'reviewer@example.com',
        tenantId: 'acme-corp',
        workflowId: 'wf-1',
      }),
    );
    expect(activityStubs.getApprovalDecision).toHaveBeenCalledWith('approval-1', 'acme-corp');
    expect(activityStubs.recordConflictResolution).toHaveBeenCalledWith({
      conflictId: 'conflict-1',
      outcome: 'resolved',
      winningFactId: 'fact-xlsx',
      decidedBy: 'reviewer@example.com',
      reason: undefined,
      tenantId: 'acme-corp',
      ruleFired: 'authority',
      proposedWinnerFactId: 'fact-xlsx',
    });
    expect(result).toEqual({
      conflictId: 'conflict-1',
      outcome: 'resolved',
      winningFactId: 'fact-xlsx',
      winningValue: 5.25,
      winningUnit: 'percent',
    });
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
      outcome: 'resolved',
    });
  });

  it('should fold requestedByOrigin into the approval summary a reviewer reads, and omit the marker when absent', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({
      decision: 'approved',
      decidedBy: 'reviewer@example.com',
    });
    activityStubs.recordConflictResolution.mockResolvedValue({
      conflictId: 'conflict-1',
      outcome: 'resolved',
    });
    const baseSummary =
      "Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25percent (source 'chunk-xlsx') over 6.1percent (source 'chunk-pdf')";

    await resolveConflict({ ...input, requestedByOrigin: 'mcp' });

    expect(activityStubs.requestConflictApproval).toHaveBeenCalledWith(
      expect.objectContaining({ summary: `${baseSummary} [requested via mcp]` }),
    );

    activityStubs.requestConflictApproval.mockClear();
    await resolveConflict(input);

    expect(activityStubs.requestConflictApproval).toHaveBeenCalledWith(
      expect.objectContaining({ summary: baseSummary }),
    );
  });

  it('should record a rejected outcome and not resolve when the persisted decision is rejected', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      capturedHandler?.();
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({
      decision: 'rejected',
      decidedBy: 'reviewer@example.com',
      reason: 'Not enough context to confirm.',
    });
    activityStubs.recordConflictResolution.mockResolvedValue({
      conflictId: 'conflict-1',
      outcome: 'rejected',
    });

    const result = await resolveConflict(input);

    expect(activityStubs.recordConflictResolution).toHaveBeenCalledWith({
      conflictId: 'conflict-1',
      outcome: 'rejected',
      decidedBy: 'reviewer@example.com',
      reason: 'Not enough context to confirm.',
      tenantId: 'acme-corp',
      ruleFired: 'authority',
      proposedWinnerFactId: 'fact-xlsx',
    });
    expect(result).toEqual({ conflictId: 'conflict-1', outcome: 'rejected' });
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
      outcome: 'rejected',
    });
  });

  it('should expire the Approval row and record a timed_out outcome, without reading the decision, when condition times out', async () => {
    condition.mockResolvedValue(false);
    activityStubs.expireApproval.mockResolvedValue(undefined);
    activityStubs.recordConflictResolution.mockResolvedValue({
      conflictId: 'conflict-1',
      outcome: 'timed_out',
    });
    const callOrder: string[] = [];
    activityStubs.expireApproval.mockImplementationOnce(() => {
      callOrder.push('expireApproval');
      return Promise.resolve();
    });
    activityStubs.recordConflictResolution.mockImplementationOnce(() => {
      callOrder.push('recordConflictResolution');
      return Promise.resolve({ conflictId: 'conflict-1', outcome: 'timed_out' });
    });

    const result = await resolveConflict(input);

    expect(activityStubs.getApprovalDecision).not.toHaveBeenCalled();
    // Regression: the durable `Approval` row must leave `pending` too, not only the `Conflict`
    // record — otherwise a human could still decide a row this dead workflow can no longer wake.
    expect(activityStubs.expireApproval).toHaveBeenCalledWith('approval-1', 'acme-corp');
    expect(callOrder).toEqual(['expireApproval', 'recordConflictResolution']);
    expect(activityStubs.recordConflictResolution).toHaveBeenCalledWith({
      conflictId: 'conflict-1',
      outcome: 'timed_out',
      tenantId: 'acme-corp',
      ruleFired: 'authority',
      proposedWinnerFactId: 'fact-xlsx',
    });
    expect(result).toEqual({ conflictId: 'conflict-1', outcome: 'timed_out' });
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
      outcome: 'timed_out',
    });
  });

  it('should ignore a signal payload that claims approval and still record rejected when the persisted row disagrees', async () => {
    condition.mockImplementation((predicate: () => boolean) => {
      // The payload claims approval — the workflow must never read it (see
      // `approvalDecisionSignal`'s doc comment); only `getApprovalDecision`'s mocked-rejected
      // response below should decide the outcome.
      capturedHandler?.({ claimedDecision: 'approved' });
      return predicate();
    });
    activityStubs.getApprovalDecision.mockResolvedValue({ decision: 'rejected' });
    activityStubs.recordConflictResolution.mockResolvedValue({
      conflictId: 'conflict-1',
      outcome: 'rejected',
    });

    const result = await resolveConflict(input);

    expect(activityStubs.recordConflictResolution).toHaveBeenCalledWith(
      expect.objectContaining({ conflictId: 'conflict-1', outcome: 'rejected' }),
    );
    expect(result).toEqual({ conflictId: 'conflict-1', outcome: 'rejected' });
  });

  it('should record the run failed with the error message and rethrow when an activity throws', async () => {
    const loadFailure = new Error('conflict not found');
    activityStubs.loadConflict.mockRejectedValue(loadFailure);

    await expect(resolveConflict(input)).rejects.toBe(loadFailure);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'failed',
      errorMessage: 'conflict not found',
    });
  });
});
