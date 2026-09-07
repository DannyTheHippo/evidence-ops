import { SYNC_SOURCE_START_TO_CLOSE_TIMEOUT_MS } from '../../src/workflows/activity-heartbeat-policy';
import { INGEST_HEARTBEAT_TIMEOUT_MS } from '../../src/workflows/ingest-retry-policy';
import { syncSource } from '../../src/workflows/sync-source.workflow';
import type { SyncSourceWorkflowInput } from '../../src/workflows/types';

interface ActivityStubs {
  runSourceSync: jest.Mock;
}

interface ProxyActivitiesOptions {
  readonly startToCloseTimeout?: number | string;
  readonly heartbeatTimeout?: number | string;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
  proxyActivities: jest.Mock<unknown, [ProxyActivitiesOptions]>;
  sleep: jest.Mock;
  continueAsNew: jest.Mock;
}

/**
 * Same mocking approach `ingest-document-version.workflow.spec.ts` uses, for the same reason (see
 * that file's own top-of-file comment): no `@temporalio/testing` package is installed, so the SDK
 * itself is mocked rather than actually run.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = { runSourceSync: jest.fn() };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    sleep: jest.fn(),
    continueAsNew: jest.fn(),
  };
});

const temporalWorkflowMock = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;
const { activityStubs, sleep, continueAsNew } = temporalWorkflowMock;

// Captured once, right after the workflow module's own top-level `proxyActivities` call runs
// (during the `syncSource` import above) and before any `afterEach(jest.resetAllMocks)` wipes
// `proxyActivities.mock.calls` — same ordering constraint `ingest-document-version.workflow.spec.ts`
// documents for its own capture.
const [syncOptions] = temporalWorkflowMock.proxyActivities.mock.calls[0];

const input: SyncSourceWorkflowInput = { sourceId: 'source-1' };

describe('syncSource', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should exit the loop without sleeping when the activity reports the source disabled', async () => {
    activityStubs.runSourceSync.mockResolvedValueOnce({ disabled: true, intervalMs: null });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(1);
    expect(activityStubs.runSourceSync).toHaveBeenCalledWith('source-1');
    expect(sleep).not.toHaveBeenCalled();
    expect(continueAsNew).not.toHaveBeenCalled();
  });

  it('should exit the loop without sleeping on a one-shot sync (no intervalMs, not disabled)', async () => {
    activityStubs.runSourceSync.mockResolvedValueOnce({ disabled: false, intervalMs: null });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(continueAsNew).not.toHaveBeenCalled();
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

  it('should call continueAsNew with the same input after 50 recurring iterations, to bound replay history', async () => {
    activityStubs.runSourceSync.mockResolvedValue({ disabled: false, intervalMs: 1000 });

    await syncSource(input);

    expect(activityStubs.runSourceSync).toHaveBeenCalledTimes(50);
    expect(sleep).toHaveBeenCalledTimes(50);
    expect(continueAsNew).toHaveBeenCalledTimes(1);
    expect(continueAsNew).toHaveBeenCalledWith(input);
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
