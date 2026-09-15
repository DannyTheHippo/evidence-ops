import { SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS } from '../../src/workflows/activity-heartbeat-policy';
import { INGEST_HEARTBEAT_TIMEOUT_MS } from '../../src/workflows/ingest-retry-policy';
import { syncSource } from '../../src/workflows/sync-source.workflow';
import type { SyncSourceWorkflowInput } from '../../src/workflows/types';

interface ActivityStubs {
  runSourceSync: jest.Mock;
  recordWorkflowRunEnd: jest.Mock;
}

interface ProxyActivitiesOptions {
  readonly startToCloseTimeout?: number | string;
  readonly heartbeatTimeout?: number | string;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock<unknown, [ProxyActivitiesOptions]>;
  log: { warn: jest.Mock };
  sleep: jest.Mock;
  continueAsNew: jest.Mock;
  workflowInfo: jest.Mock;
}

/**
 * Same mocking approach `ingest-document-version.workflow.spec.ts` uses, for the same reason (see
 * that file's own top-of-file comment): no `@temporalio/testing` package is installed, so the SDK
 * itself is mocked rather than actually run.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = { runSourceSync: jest.fn(), recordWorkflowRunEnd: jest.fn() };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    log: { warn: jest.fn() },
    sleep: jest.fn(),
    continueAsNew: jest.fn(),
    workflowInfo: jest.fn(() => ({ workflowId: 'wf-1' })),
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs, log, sleep, continueAsNew, workflowInfo } = temporalWorkflowMock;

// Captured once, right after the workflow module's own top-level `proxyActivities` calls run
// (during the `syncSource` import above) and before any `afterEach(jest.resetAllMocks)` wipes
// `proxyActivities.mock.calls` — same ordering constraint `ingest-document-version.workflow.spec.ts`
// documents for its own capture. Index 0 belongs to `run-recording.ts`'s own `runActivities` group
// (imported ahead of this file's own `syncActivities` declaration), index 1 to `syncActivities`.
const [syncOptions] = temporalWorkflowMock.proxyActivities.mock.calls[1];

const input: SyncSourceWorkflowInput = { sourceId: 'source-1' };

describe('syncSource', () => {
  beforeEach(() => {
    // `resetAllMocks()` below wipes `jest.mock`'s factory-time implementation every test — must be
    // re-set here (`jest-tests.md`'s own convention for a `jest.fn` carrying an implementation).
    workflowInfo.mockReturnValue({ workflowId: 'wf-1' });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should exit the loop without sleeping when the activity reports the source disabled, and record the run completed', async () => {
    activityStubs.runSourceSync.mockResolvedValueOnce({ disabled: true, intervalMs: null });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(1);
    expect(activityStubs.runSourceSync).toHaveBeenCalledWith('source-1');
    expect(sleep).not.toHaveBeenCalled();
    expect(continueAsNew).not.toHaveBeenCalled();
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
    });
  });

  it('should exit the loop without sleeping on a one-shot sync (no intervalMs, not disabled), and record the run completed', async () => {
    activityStubs.runSourceSync.mockResolvedValueOnce({ disabled: false, intervalMs: null });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(continueAsNew).not.toHaveBeenCalled();
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
    });
  });

  it('should sleep for intervalMs and sweep again when the source is still enabled and recurring', async () => {
    activityStubs.runSourceSync
      .mockResolvedValueOnce({ disabled: false, intervalMs: 60000 })
      .mockResolvedValueOnce({ disabled: true, intervalMs: null });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(60000);
    expect(continueAsNew).not.toHaveBeenCalled();
  });

  // `continueAsNew` throws a control-flow signal the SDK must see — the mocked version here is a
  // non-throwing `jest.fn()`, so the loop's own exit is still observable, but there is no way to
  // prove the workflow execution actually ends here as it would against a real SDK. Only the
  // not-called assertion below is available for the "no terminal write on continue-as-new" property.
  it('should call continueAsNew with the same input after 50 recurring iterations, to bound replay history, without recording a terminal run', async () => {
    activityStubs.runSourceSync.mockResolvedValue({ disabled: false, intervalMs: 1000 });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(50);
    expect(sleep).toHaveBeenCalledTimes(50);
    expect(continueAsNew).toHaveBeenCalledTimes(1);
    expect(continueAsNew).toHaveBeenCalledWith(input);
    expect(activityStubs.recordWorkflowRunEnd).not.toHaveBeenCalled();
  });

  it('should record the run failed with the error message and rethrow when the sync activity throws', async () => {
    const syncFailure = new Error('mongo unreachable');
    activityStubs.runSourceSync.mockRejectedValue(syncFailure);

    await expect(syncSource(input)).rejects.toBe(syncFailure);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'failed',
      errorMessage: 'mongo unreachable',
    });
    expect(continueAsNew).not.toHaveBeenCalled();
  });

  it('should still resolve and warn when recording the completed run rejects', async () => {
    activityStubs.runSourceSync.mockResolvedValueOnce({ disabled: true, intervalMs: null });
    activityStubs.recordWorkflowRunEnd.mockRejectedValue(new Error('recording unavailable'));

    await expect(syncSource(input)).resolves.toBeUndefined();

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workflowId: 'wf-1', status: 'completed' }),
    );
  });

  it("should rethrow the sync activity's own error and warn when recording the failed run rejects", async () => {
    const syncFailure = new Error('mongo unreachable');
    activityStubs.runSourceSync.mockRejectedValue(syncFailure);
    activityStubs.recordWorkflowRunEnd.mockRejectedValue(new Error('recording unavailable'));

    await expect(syncSource(input)).rejects.toBe(syncFailure);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workflowId: 'wf-1', status: 'failed' }),
    );
    expect(continueAsNew).not.toHaveBeenCalled();
  });
});

describe('proxyActivities retry configuration', () => {
  // A heartbeat with no timeout declared is inert — Temporal never fails a stalled sweep and never
  // delivers cancellation back to it. The pairing is asserted here because nothing in the type
  // system requires it.
  it('should declare a heartbeat timeout for runSourceSync, under its startToCloseTimeout', () => {
    expect(syncOptions.heartbeatTimeout).toBe(INGEST_HEARTBEAT_TIMEOUT_MS);
    expect(syncOptions.startToCloseTimeout).toBe(SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS);
  });
});
