import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  TOOL_AUTHZ_HOOK,
  type ToolAuthzDecision,
  type ToolAuthzHook,
} from './authz-hook.interface';
import { ToolAlreadyRegisteredException } from './exceptions/authz.exception';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionStep,
} from './types/tool-definition.type';

/**
 * `.strict()` sets `unknownKeys: 'strict'` only on the `ZodObject` it is called on — a nested
 * object schema keeps the default `strip` and silently drops an unknown key one level down
 * (verified against this repo's zod@4.4.3: `z.object({opts: z.object({a: z.string()})}).strict()`
 * still strips an unrecognized key inside `opts`). `registerTool` needs "unknown args are a
 * refusal" to hold at every depth, not just the top level, so this recurses.
 *
 * Covered: `ZodObject` (every field), `ZodArray` (`.element`), `ZodOptional`/`ZodNullable` (the
 * wrapped type) — the shapes tool authors in this codebase actually use for `argsSchema` today.
 * Not covered: `ZodDefault`, `ZodUnion`, `ZodRecord`, `ZodTuple`, `ZodLazy`, and other
 * wrapper/composite types — a tool whose schema needs one of these must extend this function
 * rather than relying on it silently passing an unrecognized-key leak through untouched.
 */
function applyStrictRecursively(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const strictShape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries<z.ZodType>(schema.shape)) {
      strictShape[key] = applyStrictRecursively(value);
    }
    return z.object(strictShape).strict();
  }
  // `.element`/`.unwrap()` are typed against zod's internal `core.$ZodType` (the default generic
  // for an unparameterized `ZodArray`/`ZodOptional`/`ZodNullable`), not the public `z.ZodType` this
  // function takes — the cast bridges that, not a widening to `any`.
  if (schema instanceof z.ZodArray) {
    return z.array(applyStrictRecursively(schema.element as z.ZodType));
  }
  if (schema instanceof z.ZodOptional) {
    return z.optional(applyStrictRecursively(schema.unwrap() as z.ZodType));
  }
  if (schema instanceof z.ZodNullable) {
    return z.nullable(applyStrictRecursively(schema.unwrap() as z.ZodType));
  }
  return schema;
}

export type ToolRefusalReason =
  | 'tool-not-registered'
  | 'tool-not-allowed-for-step'
  | 'authz-denied'
  | 'authz-hook-error'
  | 'invalid-arguments';

export interface ToolExecutionRefusal {
  readonly kind: 'refused';
  readonly reason: ToolRefusalReason;
  readonly detail: string;
}

export interface ToolExecutionSuccess {
  readonly kind: 'executed';
  readonly result: unknown;
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionRefusal;

export interface ExecuteToolInput {
  readonly step: ToolExecutionStep;
  readonly toolName: string;
  /** Untrusted — whatever the model proposed as arguments, validated by check 4 below before it
   * ever reaches a handler. */
  readonly rawArgs: unknown;
  /** Trusted counterpart to `rawArgs` — see `ToolExecutionContext`'s own doc comment. The
   * chokepoint passes this straight through to the authz hook and the handler; it never reads
   * `rawArgs` to build or adjust it. */
  readonly context: ToolExecutionContext;
}

/**
 * The single chokepoint every tool call MUST route through — "the model proposes, the application
 * disposes" applied to tool use. Its callers are `AgenticRetrievalService` (the retrieval loop's
 * `search_evidence`/`fetch_chunks`) and `McpServerService` (the external MCP surface); both
 * delegate here rather than re-implementing validation or authorization. Deliberately thin — a
 * registry, a step allowlist, an authz hook, and zod-strict argument validation.
 *
 * Fails CLOSED at every one of its four gates, evaluated in this order, deliberately before any
 * work is done on the untrusted argument payload:
 *   1. tool not registered                 -> refused, `tool-not-registered`
 *   2. tool not on the step's allowlist     -> refused, `tool-not-allowed-for-step`
 *   3. the authz hook denies, or itself throws -> refused, `authz-denied` / `authz-hook-error`
 *      (a broken permission check is not an open one — `rules/code-hygiene.md`'s
 *      failure-direction rule: permission gates fail CLOSED)
 *   4. zod-strict argument validation fails (wrong type, or a key the schema does not name)
 *      -> refused, `invalid-arguments`
 * Only a call that survives all four reaches the tool's own handler. A handler-level exception at
 * that point is the tool's own failure, not a chokepoint decision, and is left to propagate rather
 * than being folded into a refusal — conflating the two would hide a real bug behind the same
 * shape as a routine access denial.
 */
@Injectable()
export class ToolExecutorService {
  private readonly registry = new Map<string, ToolDefinition>();

  constructor(
    @Inject(TOOL_AUTHZ_HOOK)
    private readonly authzHook: ToolAuthzHook,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(ToolExecutorService.name);
  }

  /**
   * Registration-time only — `.strict()` is applied here unconditionally and recursively
   * (`applyStrictRecursively` above), rather than trusting each tool author to remember it at
   * every nesting level, so "unknown args are a refusal" is a chokepoint-wide guarantee rather
   * than a per-tool convention the next tool forgets. Throws (does not refuse) on a duplicate
   * name: this is a startup/programming error, not a runtime call outcome.
   */
  registerTool(definition: ToolDefinition): void {
    if (this.registry.has(definition.name)) {
      throw new ToolAlreadyRegisteredException(`tool '${definition.name}' is already registered`);
    }

    this.registry.set(definition.name, {
      ...definition,
      // The registry always stores a `ZodObject` here — `applyStrictRecursively` narrows to
      // `z.ZodType` internally to recurse into non-object nested schemas, but the top-level input
      // and output are always the tool's object schema.
      argsSchema: applyStrictRecursively(definition.argsSchema) as z.ZodObject,
    });
  }

  async execute(input: ExecuteToolInput): Promise<ToolExecutionResult> {
    const { step, toolName, rawArgs, context } = input;

    const tool = this.registry.get(toolName);
    if (!tool) {
      return this.refuse('tool-not-registered', `tool '${toolName}' is not registered`);
    }

    if (!step.allowedTools.includes(toolName)) {
      return this.refuse(
        'tool-not-allowed-for-step',
        `tool '${toolName}' is not on the allowlist for step '${step.stepId}'`,
      );
    }

    let decision: ToolAuthzDecision;
    try {
      decision = this.authzHook.authorize({ step, toolName, context });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.refuse(
        'authz-hook-error',
        `authorization check for '${toolName}' threw: ${message}`,
      );
    }

    // Permission gate, fails CLOSED: a decision must be the literal `true`, not merely truthy — a
    // hook returning `{allowed: 'yes'}` or `{allowed: 1}` (a malformed implementation the
    // `ToolAuthzDecision` type does not stop at runtime) must not pass the gate.
    if (decision.allowed !== true) {
      return this.refuse(
        'authz-denied',
        decision.reason ?? `authorization denied for tool '${toolName}'`,
      );
    }

    const parsed = tool.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return this.refuse(
        'invalid-arguments',
        `arguments for tool '${toolName}' failed validation: ${parsed.error.message}`,
      );
    }

    const result = await tool.handler(parsed.data, context);
    return { kind: 'executed', result };
  }

  private refuse(reason: ToolRefusalReason, detail: string): ToolExecutionRefusal {
    this.logger.warn(`Refused tool call: ${detail}`);
    return { kind: 'refused', reason, detail };
  }
}
