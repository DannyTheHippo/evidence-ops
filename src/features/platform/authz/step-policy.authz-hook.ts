import { Injectable } from '@nestjs/common';
import { UserRole } from '../../../shared/enums/user-role.enum';
import type { ToolAuthzDecision, ToolAuthzHook } from './authz-hook.interface';
import type { ToolExecutionContext, ToolExecutionStep } from './types/tool-definition.type';

/**
 * The minimum role required to invoke any tool within a given step, keyed by `ToolExecutionStep`'s
 * `stepId`. A plain, static, hand-edited constant — never assembled from a request, a tool
 * argument, or anything else computed at call time, because a policy a caller could shape through
 * its own input is not a policy. A step absent from this map has no entry and is refused
 * (`StepPolicyAuthzHook.authorize`'s fail-closed default): a new step becomes reachable only by an
 * explicit addition here, never by omission.
 */
const STEP_MINIMUM_ROLE: Readonly<Record<string, UserRole>> = {
  // `search_evidence`/`get_answer` over MCP (`src/mcp/mcp-tools.ts`) — both read-only and scoped
  // to the caller's own tenant by the verified PAT's `context.tenantId`, the same floor as asking
  // a question in the first place.
  'mcp-read': UserRole.Member,
  // `request_resolution` over MCP — the durable human approval it starts (ADR-0009) bounds
  // outcome risk, not request risk: every call writes a `WorkflowRun` and an `Approval` inbox row,
  // reachable by an AI client holding a long-lived PAT while reading corpus content that can carry
  // prompt injection. Floored at Admin, above `mcp-read`'s Member floor — a consequential write
  // reachable from a non-interactive credential needs a higher bar than a read the caller could
  // already perform by asking the question.
  'mcp-mutate': UserRole.Admin,
  // `ask_evidence` over MCP — starts the same gated Temporal pipeline `POST /questions` does,
  // bounded by the per-actor rate limiter and the daily spend ceiling rather than by role: floored
  // at Member, matching the bar a caller already clears to ask a question through the SPA.
  'mcp-ask': UserRole.Member,
  // `verify_claims` over MCP — grades caller-drafted claim text against the tenant's corpus,
  // bounded by the same rate limiter and spend ceiling `mcp-ask` is. Floored at Member: a read of
  // this tenant's own evidence, gated on spend rather than on write risk.
  'mcp-verify': UserRole.Member,
};

/** Ranks `UserRole` for a "does the caller's role meet the minimum" comparison; higher outranks
 * lower. */
const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  [UserRole.Member]: 0,
  [UserRole.Admin]: 1,
};

/**
 * Consults `STEP_MINIMUM_ROLE` against the caller's server-derived `context.role`
 * (`ToolExecutionContext`) to allow or refuse a step. **Fails CLOSED**: a step with no entry in
 * the map is refused, not allowed — a step is reachable only once it is explicitly granted a
 * minimum role here — and a `context.role` that does not resolve to a `ROLE_RANK` entry is refused
 * the same way, rather than compared with `undefined` and passed through. `context.role` is typed
 * `UserRole`, but the value can originate outside that guarantee — a Temporal workflow history
 * written by an older role enum, a manually started workflow, or a `User.role` written outside
 * Mongoose validation — so the comparison never trusts the type alone. Not the default
 * `TOOL_AUTHZ_HOOK` binding — `AuthzModule` still binds `DenyAllAuthzHook`; a module opts into this
 * policy explicitly by providing its own `TOOL_AUTHZ_HOOK` binding.
 */
@Injectable()
export class StepPolicyAuthzHook implements ToolAuthzHook {
  authorize(params: {
    readonly step: ToolExecutionStep;
    readonly toolName: string;
    readonly context: ToolExecutionContext;
  }): ToolAuthzDecision {
    const minimumRole = STEP_MINIMUM_ROLE[params.step.stepId];
    if (minimumRole === undefined) {
      return {
        allowed: false,
        reason: `no policy is configured for step '${params.step.stepId}'; refusing '${params.toolName}' by default`,
      };
    }

    const callerRank = ROLE_RANK[params.context.role];
    if (callerRank === undefined) {
      return {
        allowed: false,
        reason: `role '${params.context.role}' is not a recognized role; refusing '${params.toolName}' by default`,
      };
    }

    if (callerRank < ROLE_RANK[minimumRole]) {
      return {
        allowed: false,
        reason:
          `role '${params.context.role}' does not meet the minimum role '${minimumRole}' ` +
          `required for step '${params.step.stepId}'`,
      };
    }

    return { allowed: true };
  }
}
