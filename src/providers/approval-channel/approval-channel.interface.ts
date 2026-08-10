/**
 * Represents "ask a human to approve a consequential action, get their decision back" — no
 * real channel lands with this change; a later milestone owns the concrete implementation
 * (Slack, email, an in-app inbox, ...). Only the fake exists so callers can be written and
 * tested against the contract now.
 */
export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalRequest {
  readonly action: string;
  readonly summary: string;
  readonly context?: Record<string, unknown>;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface ApprovalChannel {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}

export const APPROVAL_CHANNEL = Symbol('APPROVAL_CHANNEL');
