import { rescanConflicts } from '../../src/workflows/rescan-conflicts.workflow';
import type { RescanConflictsWorkflowInput } from '../../src/workflows/types';

interface ActivityStubs {
  scanForConflictsByMetrics: jest.Mock;
  retractConflicts: jest.Mock;
}

interface MockedTemporalWorkflow {
  activityStubs: ActivityStubs;
}

/**
 * Same mocking approach `sync-source.workflow.spec.ts` uses, for the same reason (see that file's
 * own top-of-file comment): no `@temporalio/testing` package is installed, so the SDK itself is
 * mocked rather than actually run.
 */
jest.mock('@temporalio/workflow', () => {
  const activityStubs = {
    scanForConflictsByMetrics: jest.fn(),
    retractConflicts: jest.fn(),
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

const input: RescanConflictsWorkflowInput = {
  tenantId: 'acme-corp',
  metricIds: ['cap_rate'],
};

describe('rescanConflicts', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should proxy to scanForConflictsByMetrics then retractConflicts, and nothing else', async () => {
    activityStubs.scanForConflictsByMetrics.mockResolvedValueOnce({
      conflictsCreated: 2,
      skippedFactCount: 1,
    });
    activityStubs.retractConflicts.mockResolvedValueOnce({ conflictsRetracted: 3 });

    const result = await rescanConflicts(input);

    expect(activityStubs.scanForConflictsByMetrics).toHaveBeenCalledTimes(1);
    expect(activityStubs.scanForConflictsByMetrics).toHaveBeenCalledWith('acme-corp', ['cap_rate']);
    expect(activityStubs.retractConflicts).toHaveBeenCalledTimes(1);
    expect(activityStubs.retractConflicts).toHaveBeenCalledWith('acme-corp', ['cap_rate']);
    expect(result).toEqual({ conflictsCreated: 2, conflictsRetracted: 3, skippedFactCount: 1 });
  });

  it('should scan before retracting, not the other way around', async () => {
    const callOrder: string[] = [];
    activityStubs.scanForConflictsByMetrics.mockImplementationOnce(() => {
      callOrder.push('scan');
      return Promise.resolve({ conflictsCreated: 0, skippedFactCount: 0 });
    });
    activityStubs.retractConflicts.mockImplementationOnce(() => {
      callOrder.push('retract');
      return Promise.resolve({ conflictsRetracted: 0 });
    });

    await rescanConflicts(input);

    expect(callOrder).toEqual(['scan', 'retract']);
  });
});
