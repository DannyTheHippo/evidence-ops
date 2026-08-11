/**
 * Represents "ask a human to approve a consequential action, get their decision back".
 * `MongoApprovalChannel` (D1 of the approvals milestone) implements persistence; the wait itself
 * stays out of this provider on purpose. ADR-0003 puts a human approval gate in workflow code as
 * `await condition(pred, '24 hours')` plus a signal, never a polling loop — so a Mongo-backed
 * `requestApproval` that blocked until decided would be re-implementing exactly what Temporal
 * already owns, inside an activity that cannot durably sleep for days. That is why this contract
 * is two calls instead of one blocking round trip: `requestApproval` persists the pending request
 * and hands back an id; the workflow that later owns waiting (D2, not this change) wakes on a
 * signal or a timeout and calls `getDecision` to read the durable, authoritative state — never
 * the signal payload itself, so a spoofed or stale signal can't forge an approval.
 */
export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalSubject {
  readonly entityType: string;
  readonly entityId: string;
}

export interface ApprovalRequest {
  readonly action: string;
  readonly summary: string;
  readonly subject: ApprovalSubject;
  readonly requestedBy?: string;
  /** Omitted → the channel's own tenant default, matching every other write path in this repo
   *  (`DEFAULT_TENANT_ID`). Explicit here rather than implicit: `9f0c2f2` was a tenant-isolation
   *  break from exactly this kind of field being assumed rather than threaded through. */
  readonly tenantId?: string;
  readonly context?: Record<string, unknown>;
}

export interface ApprovalHandle {
  readonly id: string;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
  getDecision(approvalId: string): Promise<ApprovalResult>;
}

export const APPROVAL_CHANNEL = Symbol('APPROVAL_CHANNEL');
