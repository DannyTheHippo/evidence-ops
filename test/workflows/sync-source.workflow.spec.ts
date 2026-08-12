import { syncSource } from '../../src/workflows/sync-source.workflow';
import type { SyncSourceWorkflowInput } from '../../src/workflows/types';

interface ActivityStubs {
  runSourceSync: jest.Mock;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
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
