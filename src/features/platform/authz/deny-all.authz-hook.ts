import { Injectable } from '@nestjs/common';
import type { ToolAuthzDecision, ToolAuthzHook } from './authz-hook.interface';
import type { ToolExecutionContext, ToolExecutionStep } from './types/tool-definition.type';

/**
 * The module's default `TOOL_AUTHZ_HOOK` binding (`./authz.module.ts`). No caller is wired to
 * `ToolExecutorService` yet and no real authorization policy has been designed (see ADR-0005), so
 * the only honest default is refusing every call — a permission gate that "allows until told
 * otherwise" is exactly the failure mode the fail-closed rule in `rules/code-hygiene.md` exists to
 * prevent. Swapping this binding for a real policy is a decision a future caller makes explicitly
 * by providing its own `TOOL_AUTHZ_HOOK`, not a default anyone falls into.
 */
@Injectable()
export class DenyAllAuthzHook implements ToolAuthzHook {
  authorize(params: {
    readonly step: ToolExecutionStep;
    readonly toolName: string;
    readonly context: ToolExecutionContext;
  }): ToolAuthzDecision {
    return {
      allowed: false,
      reason:
        `no authorization policy is configured for step '${params.step.stepId}'; refusing ` +
        `'${params.toolName}' by default`,
    };
  }
}
