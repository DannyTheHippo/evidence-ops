import { FakeApprovalChannel } from '../../../src/providers/approval-channel/fake-approval.channel';

describe('FakeApprovalChannel', () => {
  let channel: FakeApprovalChannel;

  const request = {
    action: 'publish_report',
    summary: 'Publish the Q1 evidence report',
    subject: { entityType: 'WorkflowRun', entityId: 'run-1' },
    tenantId: 'acme-corp',
  };

  beforeEach(() => {
    channel = new FakeApprovalChannel();
  });

  it('should record the request and mint an id without resolving a decision', async () => {
    const handle = await channel.requestApproval(request);

    expect(handle).toEqual({ id: 'fake-approval-1' });
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0].action).toBe('publish_report');
  });

  it('should mint distinct ids across multiple requests', async () => {
    const first = await channel.requestApproval(request);
    const second = await channel.requestApproval(request);

    expect(first.id).not.toBe(second.id);
  });

  it('should return the queued decision from getDecision', async () => {
    channel.enqueueDecision({ decision: 'approved', decidedBy: 'reviewer@example.com' });

    const result = await channel.getDecision('fake-approval-1');

    expect(result).toEqual({ decision: 'approved', decidedBy: 'reviewer@example.com' });
  });

  it('should return queued decisions in FIFO order across multiple calls', async () => {
    channel.enqueueDecision({ decision: 'rejected', reason: 'insufficient evidence' });
    channel.enqueueDecision({ decision: 'approved' });

    const first = await channel.getDecision('fake-approval-1');
    const second = await channel.getDecision('fake-approval-2');

    expect(first.decision).toBe('rejected');
    expect(second.decision).toBe('approved');
  });

  it('should throw loudly when getDecision is called with no queued decision', async () => {
    await expect(channel.getDecision('fake-approval-1')).rejects.toThrow(/no queued decision/);
  });
});
