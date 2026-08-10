import { FakeApprovalChannel } from '../../../src/providers/approval-channel/fake-approval.channel';

describe('FakeApprovalChannel', () => {
  let channel: FakeApprovalChannel;

  beforeEach(() => {
    channel = new FakeApprovalChannel();
  });

  it('should return the queued decision and record the request', async () => {
    channel.enqueueDecision({ decision: 'approved', decidedBy: 'reviewer@example.com' });

    const result = await channel.requestApproval({
      action: 'publish_report',
      summary: 'Publish the Q1 evidence report',
    });

    expect(result).toEqual({ decision: 'approved', decidedBy: 'reviewer@example.com' });
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0].action).toBe('publish_report');
  });

  it('should return queued decisions in FIFO order across multiple calls', async () => {
    channel.enqueueDecision({ decision: 'rejected', reason: 'insufficient evidence' });
    channel.enqueueDecision({ decision: 'approved' });

    const first = await channel.requestApproval({ action: 'a', summary: 'first' });
    const second = await channel.requestApproval({ action: 'b', summary: 'second' });

    expect(first.decision).toBe('rejected');
    expect(second.decision).toBe('approved');
  });

  it('should throw loudly when called with no queued decision', async () => {
    await expect(
      channel.requestApproval({ action: 'publish_report', summary: 'no decision queued' }),
    ).rejects.toThrow(/no queued decision/);
  });
});
