import type { ToolExecutionContext, ToolExecutionStep } from './types/tool-definition.type';

export interface ToolAuthzDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * The deterministic access decision the model never makes. Synchronous by construction — deciding
 * "is this call allowed" is a computation over already-known facts (the step, the tool name, the
 * caller's `ToolExecutionContext`), not an I/O operation, and keeping the interface synchronous
 * rules out an entire class of timeout/TOCTOU bugs a `Promise`-based hook would open at the one
 * place this codebase can least afford one. A future caller whose policy needs a DB or session
 * lookup resolves that ahead of the call and passes the already-resolved facts through `context`;
 * the hook itself never awaits anything.
 */
export interface ToolAuthzHook {
  authorize(params: {
    readonly step: ToolExecutionStep;
    readonly toolName: string;
    readonly context: ToolExecutionContext;
  }): ToolAuthzDecision;
}

export const TOOL_AUTHZ_HOOK = Symbol('TOOL_AUTHZ_HOOK');
