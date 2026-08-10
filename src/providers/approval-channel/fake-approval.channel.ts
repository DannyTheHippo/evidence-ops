import { Injectable } from '@nestjs/common';
import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
} from './approval-channel.interface';

/**
 * Test double for `ApprovalChannel`. Consumers queue decisions with `enqueueDecision()`; a
 * call beyond the queue throws rather than silently defaulting to approved/rejected — a test
 * under-mocking its expected approval count should fail loudly, not pass on a guessed outcome.
 */
@Injectable()
export class FakeApprovalChannel implements ApprovalChannel {
  readonly requests: ApprovalRequest[] = [];

  private readonly queue: ApprovalResult[] = [];

  enqueueDecision(result: ApprovalResult): void {
    this.queue.push(result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    this.requests.push(request);

    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        'FakeApprovalChannel.requestApproval called with no queued decision — call enqueueDecision() first',
      );
    }

    return next;
  }
}
