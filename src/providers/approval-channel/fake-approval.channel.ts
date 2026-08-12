import { Injectable } from '@nestjs/common';
import type {
  ApprovalChannel,
  ApprovalHandle,
  ApprovalRequest,
  ApprovalResult,
} from './approval-channel.interface';

/**
 * Test double for `ApprovalChannel`. `requestApproval()` only records the request and mints an
 * id — it never resolves a decision itself, mirroring the real channel's split between
 * persisting a request and reading back a decision. Consumers queue decisions with
 * `enqueueDecision()`; a `getDecision()` call beyond the queue throws rather than silently
 * defaulting to approved/rejected — a test under-mocking its expected approval count should fail
 * loudly, not pass on a guessed outcome.
 */
@Injectable()
export class FakeApprovalChannel implements ApprovalChannel {
  readonly requests: ApprovalRequest[] = [];

  private readonly queue: ApprovalResult[] = [];

  private nextId = 0;

  enqueueDecision(result: ApprovalResult): void {
    this.queue.push(result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async requestApproval(request: ApprovalRequest): Promise<ApprovalHandle> {
    this.requests.push(request);
    this.nextId += 1;

    return { id: `fake-approval-${this.nextId}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async getDecision(_approvalId: string, _tenantId?: string): Promise<ApprovalResult> {
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        'FakeApprovalChannel.getDecision called with no queued decision — call enqueueDecision() first',
      );
    }

    return next;
  }
}
