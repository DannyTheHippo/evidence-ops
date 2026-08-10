import type { z } from 'zod';

/**
 * One callable action the deterministic chokepoint (`../tool-executor.service.ts`) may execute on
 * the model's behalf. `argsSchema` MUST be a `ZodObject` — `ToolExecutorService.registerTool`
 * applies `.strict()` recursively (see `applyStrictRecursively` in `../tool-executor.service.ts`)
 * over every nested `ZodObject`, `ZodArray` element, and `ZodOptional`/`ZodNullable` wrapper, so an
 * argument key the schema does not name is a refusal at any nesting depth, never a silent strip —
 * plain `.strict()` only covers the top-level object. That mirrors the trap the global
 * `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted` closes for HTTP request DTOs (see
 * `rules/nestjs.md`), applied to a channel that has no `ValidationPipe` in front of it.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly argsSchema: z.ZodObject;
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The step-scoped policy a caller presents alongside a proposed tool call. `allowedTools` is a
 * per-step allowlist, not a global one — a tool registered for one step of a multi-step plan is
 * refused in every other step unless that step lists it too.
 */
export interface ToolExecutionStep {
  readonly stepId: string;
  readonly allowedTools: readonly string[];
}
