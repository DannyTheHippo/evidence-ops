import { withRunRecording } from '../../src/workflows/run-recording';

interface MockedTemporalWorkflow {
  activityStubs: { recordWorkflowRunEnd: jest.Mock };
  log: { warn: jest.Mock };
  workflowInfo: jest.Mock;
}

/**
 * Same mocking approach `sync-source.workflow.spec.ts` uses: no `@temporalio/testing` package is
 * installed, so the SDK itself is mocked rather than actually run.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = { recordWorkflowRunEnd: jest.fn() };
  return {
    activityStubs,
    proxyActivities: jest.fn(() => activityStubs),
    log: { warn: jest.fn() },
    workflowInfo: jest.fn(() => ({ workflowId: 'wf-1' })),
  };
});

const { activityStubs, log, workflowInfo } = jest.requireMock(
  '@temporalio/workflow',
) as unknown as MockedTemporalWorkflow;

describe('withRunRecording', () => {
  beforeEach(() => {
    // `resetAllMocks()` below wipes `jest.mock`'s factory-time implementation every test.
    workflowInfo.mockReturnValue({ workflowId: 'wf-1' });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should resolve with the body result and warn when recording the completed run rejects', async () => {
    activityStubs.recordWorkflowRunEnd.mockRejectedValue(new Error('mongo unreachable'));

    await expect(
      withRunRecording(
        () => Promise.resolve({ outcome: 'resolved' as const }),
        (result) => result.outcome,
      ),
    ).resolves.toEqual({ outcome: 'resolved' });

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledTimes(1);
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'completed',
      outcome: 'resolved',
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        status: 'completed',
        error: 'mongo unreachable',
      }),
    );
  });

  it('should warn with the cause chain message when the rejection carries a cause', async () => {
    const cause = new Error('mongo unreachable');
    activityStubs.recordWorkflowRunEnd.mockRejectedValue(
      new Error('Activity task failed', { cause }),
    );

    await expect(
      withRunRecording(
        () => Promise.resolve({ outcome: 'resolved' as const }),
        (result) => result.outcome,
      ),
    ).resolves.toEqual({ outcome: 'resolved' });

    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        status: 'completed',
        error: 'Activity task failed',
        cause: 'mongo unreachable',
      }),
    );
  });

  it("should rethrow the body's own error and warn when recording the failed run rejects", async () => {
    const bodyError = new Error('grounding check failed');
    activityStubs.recordWorkflowRunEnd.mockRejectedValue(new Error('mongo unreachable'));

    await expect(withRunRecording(() => Promise.reject(bodyError))).rejects.toBe(bodyError);

    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledTimes(1);
    expect(activityStubs.recordWorkflowRunEnd).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      status: 'failed',
      errorMessage: 'grounding check failed',
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workflowId: 'wf-1', status: 'failed', error: 'mongo unreachable' }),
    );
  });
});
