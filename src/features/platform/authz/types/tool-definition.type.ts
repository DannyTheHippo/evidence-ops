import type { z } from 'zod';
import type { UserRole } from '../../../../shared/enums/user-role.enum';

/**
 * One callable action the deterministic chokepoint (`../tool-executor.service.ts`) may execute on
 * the model's behalf. `argsSchema` MUST be a `ZodObject` — `ToolExecutorService.registerTool`
 * applies `.strict()` recursively (see `applyStrictRecursively` in `../tool-executor.service.ts`)
 * over every nested `ZodObject`, `ZodArray` element, and `ZodOptional`/`ZodNullable` wrapper, so an
 * argument key the schema does not name is a refusal at any nesting depth, never a silent strip —
 * plain `.strict()` only covers the top-level object. That mirrors the trap the global
 * `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted` closes for HTTP request DTOs (see
 * `rules/nestjs.md`), applied to a channel that has no `ValidationPipe` in front of it.
 *
 * `handler` receives the validated args and the caller's `ToolExecutionContext` — never the raw,
 * untrusted `rawArgs` the chokepoint received (see `ExecuteToolInput.rawArgs`).
 */
export interface ToolDefinition {
  readonly name: string;
  readonly argsSchema: z.ZodObject;
  readonly handler: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
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

/**
 * Who is asking. **Server-derived only** — the caller builds this from the authenticated session
 * or the verified token before calling `ToolExecutorService.execute`, never from the model's
 * proposed tool arguments. The chokepoint passes it straight through to the authz hook and the
 * handler without reading or combining it with `rawArgs` in any way, so nothing in the untrusted
 * argument payload can shape who the call is authorized as. That is the whole reason this type
 * exists as a field separate from a tool's own `args`: an argument the model wrote can be refused
 * by validation, but it can never become the identity a policy decision is made against.
 */
export interface ToolExecutionContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: UserRole;
  /** The verified caller's own email, when the surface that built this context resolved one
   *  (`PatTokenVerifier` does, from `VerifiedIdentity.email`). Optional — the interactive HTTP
   *  path and the agentic-retrieval activity build a context from a JWT/workflow input that carries
   *  no email, and neither needs to. A handler that wants an approver-facing identity string reads
   *  this before falling back to `actorId`. */
  readonly email?: string;
}
