import { Inject, Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toJSONSchema } from 'zod/v4';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { ClaimVerificationService } from '../features/evidence/qa/claim-verification.service';
import { ConflictsService } from '../features/evidence/conflicts/conflicts.service';
import { EvidenceRetrievalService } from '../features/evidence/qa/evidence-retrieval.service';
import { QaService } from '../features/evidence/qa/qa.service';
import { buildSearchEvidenceTool } from '../features/evidence/retrieval/evidence-tools';
import type { ToolExecutionResult } from '../features/platform/authz/tool-executor.service';
import { ToolExecutorService } from '../features/platform/authz/tool-executor.service';
import type {
  ToolExecutionContext,
  ToolExecutionStep,
} from '../features/platform/authz/types/tool-definition.type';
import type { ModelToolDefinition } from '../providers/model/model-provider.interface';
import { AlsContext } from '../shared/types/als-context.type';
import { AuditService } from '../shared/services/audit/audit.service';
import { AppLogger } from '../shared/services/logger/logger.service';
import {
  askEvidenceToolDefinition,
  ASK_EVIDENCE_TOOL_NAME,
  buildAskEvidenceTool,
  buildGetAnswerTool,
  buildRequestResolutionTool,
  buildVerifyClaimsTool,
  getAnswerToolDefinition,
  MCP_ASK_STEP,
  MCP_MUTATE_STEP,
  MCP_READ_STEP,
  MCP_VERIFY_STEP,
  mcpSearchEvidenceToolDefinition,
  REQUEST_RESOLUTION_TOOL_NAME,
  requestResolutionToolDefinition,
  VERIFY_CLAIMS_TOOL_NAME,
  verifyClaimsToolDefinition,
} from './mcp-tools';
import {
  MCP_RATE_LIMIT_WINDOW_MS,
  MCP_SERVER_INFO,
  MCP_TOOL_CALL_EXECUTED_ACTION,
  MCP_TOOL_CALL_FAILED_ACTION,
  MCP_TOOL_CALL_REFUSED_ACTION,
} from './mcp.constant';
import { PatTokenVerifier } from './pat-token.verifier';

/** Tools whose handler spends model or embedding-provider budget — either by calling a model
 *  directly, like `verify_claims` (`ClaimVerificationService.verifyClaims`, one model call per
 *  submitted claim), by billing a paid embedding call, like `search_evidence`
 *  (`EvidenceRetrievalService.retrieve` → `MongoHybridRetrievalStore.search` → `embedQuery`, which
 *  calls `SpendGuardEmbeddingProvider.embed` and bills Voyage), or by starting a workflow that
 *  will, like `ask_evidence` (`QaService.startQuestion` → the Temporal answer pipeline →
 *  `SynthesisService`). This is the whole extension point for a further spend-metered tool: add
 *  its `ModelToolDefinition` here, and its `registerTool` call joins the others inside the
 *  `spendGateOpen` branch in the constructor below. Every tool NOT in this array is gate-exempt
 *  because it never reaches a model or a paid embedding call. */
const SPEND_GATED_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  mcpSearchEvidenceToolDefinition,
  askEvidenceToolDefinition,
  verifyClaimsToolDefinition,
];

const SPEND_GATED_TOOL_NAMES: readonly string[] = SPEND_GATED_TOOL_DEFINITIONS.map(
  (definition) => definition.name,
);

const ADVERTISED_TOOLS_BASE: readonly ModelToolDefinition[] = [
  getAnswerToolDefinition,
  requestResolutionToolDefinition,
];

const ADVERTISED_TOOLS: readonly ModelToolDefinition[] = [
  ...ADVERTISED_TOOLS_BASE,
  ...SPEND_GATED_TOOL_DEFINITIONS,
];

/** Picks the step to present to `ToolExecutorService.execute` by the tool name the caller asked
 *  for, defaulting to `MCP_READ_STEP` — an unrecognized name still fails closed downstream
 *  (`tool-not-registered`), but the default direction here must never widen to the mutating or
 *  ask step for a name this function does not explicitly recognize. */
function stepForTool(toolName: string): ToolExecutionStep {
  if (toolName === REQUEST_RESOLUTION_TOOL_NAME) {
    return MCP_MUTATE_STEP;
  }
  if (toolName === ASK_EVIDENCE_TOOL_NAME) {
    return MCP_ASK_STEP;
  }
  if (toolName === VERIFY_CLAIMS_TOOL_NAME) {
    return MCP_VERIFY_STEP;
  }
  return MCP_READ_STEP;
}

function toMcpTool(definition: ModelToolDefinition): Tool {
  return {
    name: definition.name,
    description: definition.description,
    // `{reused: 'inline'}` matches `toStructuredOutputFormat`'s own call
    // (`../providers/model/structured-output-format.util.ts`) — neither tool's schema here nests
    // a reused subschema, so the option is inert today, but it keeps every `toJSONSchema` call
    // site in the codebase agreeing on the same expansion strategy rather than defaulting
    // silently. `ModelToolDefinition.inputSchema` is always object-rooted for every tool this
    // codebase defines (see that field's own doc comment), so the cast holds.
    inputSchema: toJSONSchema(definition.inputSchema, { reused: 'inline' }) as Tool['inputSchema'],
  };
}

/** Maps a chokepoint decision onto the MCP wire shape: a refusal is `isError: true` carrying the
 *  chokepoint's own reason, never a thrown protocol error — the caller gets a normal tool result
 *  it can inspect, not a JSON-RPC failure indistinguishable from a transport problem. */
function toCallToolResult(result: ToolExecutionResult): CallToolResult {
  if (result.kind === 'refused') {
    return {
      isError: true,
      content: [{ type: 'text', text: `${result.reason}: ${result.detail}` }],
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(result.result) }] };
}

/**
 * The MCP protocol layer: builds one low-level `Server` per verified caller, advertises
 * `get_answer`/`request_resolution` unconditionally, plus every spend-gated tool
 * (`SPEND_GATED_TOOL_DEFINITIONS`: `search_evidence`, `ask_evidence`, `verify_claims`) while
 * `config.spend.dailyLimitUsd > 0`, via `tools/list` from the same zod schemas
 * `ToolExecutorService` validates against (`this.advertisedTools`, `toMcpTool`), and routes
 * `tools/call` through `ToolExecutorService.execute` — the single chokepoint every tool call in
 * this codebase must route through (see that class's own doc comment). Never re-implements
 * validation or authorization itself. `stepForTool` presents `MCP_MUTATE_STEP` for
 * `request_resolution`, `MCP_ASK_STEP` for `ask_evidence`, `MCP_VERIFY_STEP` for `verify_claims`,
 * and `MCP_READ_STEP` for everything else (`search_evidence` and `get_answer`), so each tool kind
 * is policed under its own `STEP_MINIMUM_ROLE` floor even though all route through the same call.
 *
 * The spend gate fails CLOSED: an unmeasurable spend ceiling (`dailyLimitUsd <= 0`, the same
 * disable convention `SpendGuardModelProvider`/`SpendGuardEmbeddingProvider` read) withdraws every
 * tool whose handler can bill a vendor from both `tools/list` and the registry, rather than
 * leaving it reachable unmetered. A long-lived headless PAT under a ceiling meant only to be "off
 * in dev" would otherwise carry an unmetered budget the moment `search_evidence` reaches
 * `SpendGuardEmbeddingProvider` — `EvidenceRetrievalService.retrieve` →
 * `MongoHybridRetrievalStore.search` → `embedQuery` calls `SpendGuardEmbeddingProvider.embed`,
 * which itself fails OPEN at the same `dailyLimitUsd <= 0` value this gate closes on, so this gate
 * is what stops that combination from billing Voyage with no ceiling — or the moment
 * `ask_evidence`/`verify_claims` reach `SynthesisService`/`ClaimVerificationService`. `get_answer`
 * stays gate-exempt because its whole path is a Mongo read plus an audit write
 * (`QaService.getAnswerById` → `peekAnswer`, `answerModel.findOne`), never a model or embedding
 * call. `request_resolution` stays gate-exempt because it spends nothing at request time:
 * `ConflictsService.requestResolution` only reads Mongo (the conflict, `MetricPoliciesService
 * .resolveForTenant`) and calls `workflowEngine.start`, which enqueues the `resolveConflict`
 * workflow without waiting for it — any model spend that workflow's own activities might later
 * incur happens on a Temporal worker process, outside this call and outside this gate's reach.
 *
 * With the ceiling disabled, the surface that remains is deliberately narrower than three tools —
 * only `get_answer`/`request_resolution` stay reachable, so a client that starts a question or
 * proposes a resolution can still be told how it turned out, but nothing on this surface can
 * search the corpus or spend further budget. That is the intended fail-closed posture, not a gap:
 * the constructor's `logger.warn` below names exactly which tools were withheld
 * (`SPEND_GATED_TOOL_NAMES`), so an operator watching a client's `tools/list` shrink has a
 * corresponding server-side line explaining why.
 *
 * `registerTool` runs once, in the constructor, against the single `ToolExecutorService`
 * instance `McpModule` constructs for this process (bound to `StepPolicyAuthzHook` — see that
 * module's own comment on why the binding must be re-provided alongside the service, not just
 * the token). Every `buildServer` call reuses that one registry; only the returned `Server`
 * itself is per-request.
 */
@Injectable()
export class McpServerService {
  /** Fixed-window request counters, keyed by the verified `actorId` — a caller with multiple PATs
   *  cannot multiply their own budget, and one tenant's callers cannot starve each other. Held on
   *  the singleton service, not the per-request `Server`, since a `Server` this class returns
   *  lives only as long as one stateless HTTP request. In-memory and per-process: correct for a
   *  single-replica surface with no shared counter store, not for horizontal scale-out.
   *  `applyFixedWindow` evicts a key's own expired window on the call that would otherwise reuse
   *  it, so this stays bounded to currently active actors rather than growing for as long as the
   *  process has been up. Distinct from `preAuthIpRateLimitWindows` below: this map only ever sees
   *  a caller who already holds a live PAT. */
  private readonly rateLimitWindows = new Map<string, { windowStart: number; count: number }>();

  /** Same fixed-window shape as `rateLimitWindows`, keyed by caller IP instead of `actorId` —
   *  `checkPreAuthIpRateLimit` reads it, called from `src/mcp/main.ts` before `authenticate`, so an
   *  unauthenticated flood is bounded before it ever reaches `PatTokenVerifier.verify` (a Mongo
   *  lookup per call). The two limiters coexist deliberately: this one polices callers with no
   *  verified identity yet, `rateLimitWindows` polices verified callers by budget. */
  private readonly preAuthIpRateLimitWindows = new Map<
    string,
    { windowStart: number; count: number }
  >();

  /** `ADVERTISED_TOOLS`, minus the spend-gated tools when `config.spend.dailyLimitUsd <= 0` — set
   *  once in the constructor and reused by every `buildServer` call, the same way the tool
   *  registry itself is. */
  private readonly advertisedTools: readonly ModelToolDefinition[];

  constructor(
    private readonly toolExecutor: ToolExecutorService,
    private readonly patTokenVerifier: PatTokenVerifier,

    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,

    private readonly config: TypedConfigService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
    evidenceRetrievalService: EvidenceRetrievalService,
    qaService: QaService,
    conflictsService: ConflictsService,
    claimVerificationService: ClaimVerificationService,
  ) {
    this.logger.init(McpServerService.name);
    this.toolExecutor.registerTool(buildGetAnswerTool(qaService));
    this.toolExecutor.registerTool(buildRequestResolutionTool(conflictsService));

    const spendGateOpen = this.config.spend.dailyLimitUsd > 0;
    if (spendGateOpen) {
      // Extend this branch, alongside `SPEND_GATED_TOOL_DEFINITIONS` above, when a further
      // spend-metered tool lands.
      this.toolExecutor.registerTool(buildSearchEvidenceTool(evidenceRetrievalService));
      this.toolExecutor.registerTool(buildAskEvidenceTool(qaService));
      this.toolExecutor.registerTool(buildVerifyClaimsTool(claimVerificationService));
      this.advertisedTools = ADVERTISED_TOOLS;
    } else {
      this.logger.warn(
        `MODEL_SPEND_DAILY_LIMIT_USD is <= 0; withholding spend-gated MCP tools ` +
          `(${SPEND_GATED_TOOL_NAMES.join(', ')}) from this surface`,
      );
      this.advertisedTools = ADVERTISED_TOOLS_BASE;
    }
  }

  /** Resolves the `Authorization` header to a server-derived `ToolExecutionContext` by
   *  delegating to `PatTokenVerifier` — see that class's own doc comment for the fail-closed
   *  contract this passes straight through (`null` for anything short of a live, verified PAT). */
  async authenticate(
    authorizationHeader: string | undefined,
  ): Promise<ToolExecutionContext | null> {
    return this.patTokenVerifier.verify(authorizationHeader);
  }

  /**
   * Fixed-window limiter: `true` once the caller's window has budget for `cost` more units, up to
   * `config.mcp.rateLimitPerMinute` within any rolling `MCP_RATE_LIMIT_WINDOW_MS` window per
   * `actorId`, `false` once granting `cost` would exceed that budget. `cost` defaults to `1` — a
   * plain single-message POST charges exactly what it always has — but a caller charges the actual
   * `countRateLimitCost` of one HTTP POST's JSON-RPC body, so a batch of N requests spends N units
   * in one call rather than the one unit the transport-level HTTP request would otherwise cost.
   * Fails CLOSED — there is no branch that defaults to allowing a call; a window with no prior
   * record still refuses when `cost` alone exceeds the per-window budget, and a batch that would
   * exceed the *remaining* budget is refused wholesale rather than partially admitted.
   */
  checkRateLimit(actorId: string, cost = 1): boolean {
    return this.applyFixedWindow(
      this.rateLimitWindows,
      actorId,
      cost,
      this.config.mcp.rateLimitPerMinute,
      MCP_RATE_LIMIT_WINDOW_MS,
    );
  }

  /**
   * IP-keyed counterpart to `checkRateLimit`, gating `src/mcp/main.ts` *before* `authenticate` runs
   * — the actor-keyed limiter above only ever sees a caller who already holds a live PAT, so
   * without this an unauthenticated flood was never limited at all while each request still paid
   * for a `PatTokenVerifier.verify` lookup. Budget is `config.mcp.preAuthIpRateLimitMaxRequests`
   * per rolling `config.mcp.preAuthIpRateLimitWindowMs` window per IP; `cost` is always `1` since a
   * caller with no verified identity yet cannot present a JSON-RPC batch this surface trusts to
   * size a request. Fails CLOSED for the same reason `checkRateLimit` does.
   */
  checkPreAuthIpRateLimit(ip: string): boolean {
    return this.applyFixedWindow(
      this.preAuthIpRateLimitWindows,
      ip,
      1,
      this.config.mcp.preAuthIpRateLimitMaxRequests,
      this.config.mcp.preAuthIpRateLimitWindowMs,
    );
  }

  /**
   * Shared fixed-window admission check behind both limiters above. Evicts every window in `windows`
   * that has already fully elapsed before looking `key` up, so a map keyed by a high-cardinality
   * caller identity (an actor id, or an IP under a flood) stays bounded to currently active keys
   * rather than accumulating one entry per caller the process has ever seen. A key with no
   * surviving window is refused without being stored — a caller who is refused before ever
   * succeeding once leaves no window behind to evict later.
   */
  private applyFixedWindow(
    windows: Map<string, { windowStart: number; count: number }>,
    key: string,
    cost: number,
    limit: number,
    windowMs: number,
  ): boolean {
    const now = Date.now();
    for (const [windowKey, window] of windows) {
      if (now - window.windowStart >= windowMs) {
        windows.delete(windowKey);
      }
    }

    const existing = windows.get(key);
    if (!existing) {
      const allowed = cost <= limit;
      if (allowed) {
        windows.set(key, { windowStart: now, count: cost });
      }
      return allowed;
    }

    if (existing.count + cost > limit) {
      return false;
    }

    existing.count += cost;
    return true;
  }

  /**
   * One `Server` per verified caller, closing over `context` — never over anything from a
   * request the model could shape. `tools/call` establishes a fresh ALS scope per call
   * (`als.run`, mirroring `withTenantScope` in `../worker/activities.ts`) so `AuditService` and
   * `auditablePlugin` see `store.user`/`store.tenant` exactly as they would for a request that
   * came in through `JwtAuthGuard`, even though nothing here runs behind that guard. That scope
   * also carries `origin: 'mcp'`, which `AuditService.record` reads: every row a shared service
   * writes during the call (`qa.answer.viewed`, `conflicts.resolution_requested`) is labelled as
   * MCP-originated rather than indistinguishable from a person using the SPA.
   *
   * Every `tools/call` writes exactly one row of its own here, at the boundary rather than inside
   * the services the tools delegate to: a read-only tool like `search_evidence` audits nothing on
   * its own (`EvidenceRetrievalService.retrieve` is shared with the worker's single-shot retrieval
   * activity, where a row per question is already recorded at `qa.question.started`), and a
   * refusal never reaches a service at all. The write happens in a `finally` around the executor
   * call, not after it returns: a registered, authorized, well-formed call whose handler itself
   * throws — a `get_answer` for an id that does not exist, for one — still leaves a row, carrying
   * `MCP_TOOL_CALL_FAILED_ACTION` rather than either of the other two actions, so a thrown handler
   * is never silently indistinguishable from a miss with no row at all. The row carries the tool
   * name, the outcome, and — on a refusal — the chokepoint's reason, but never the arguments: those
   * are model-controlled and can carry corpus text, so what is recorded answers "who called what,
   * when", not "what did the payload say". The write fails CLOSED: it is awaited inside the
   * `finally` before the result (or the original error) goes back, so a failed audit write
   * surfaces as a protocol error and no tool output is disclosed without a record of the call.
   */
  buildServer(context: ToolExecutionContext): Server {
    const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.advertisedTools.map(toMcpTool),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: toolArgs } = request.params;

      const result = await this.als.run(
        {
          'correlation-id': randomUUID(),
          user: context.actorId,
          tenant: context.tenantId,
          origin: 'mcp',
        },
        async () => {
          // `executed` stays `undefined` only when `execute` throws before assigning it — that is
          // the sole signal the `finally` block below needs to tell a handler throw apart from a
          // refusal or a success, without a separate `catch` re-throwing to set a flag.
          let executed: ToolExecutionResult | undefined;
          try {
            executed = await this.toolExecutor.execute({
              step: stepForTool(name),
              toolName: name,
              rawArgs: toolArgs ?? {},
              context,
            });
            return executed;
          } finally {
            await this.auditService.record({
              action:
                executed === undefined
                  ? MCP_TOOL_CALL_FAILED_ACTION
                  : executed.kind === 'refused'
                    ? MCP_TOOL_CALL_REFUSED_ACTION
                    : MCP_TOOL_CALL_EXECUTED_ACTION,
              actorId: context.actorId,
              // No entity is common to all three tools, and `entityId` must be an ObjectId — the
              // caller themselves is the subject, as in `AuditEventsService.list`'s own row.
              subject: { entityType: 'User', entityId: context.actorId },
              tenantId: context.tenantId,
              origin: 'mcp',
              toolName: name,
              refusalReason: executed?.kind === 'refused' ? executed.reason : undefined,
            });
          }
        },
      );

      return toCallToolResult(result);
    });

    return server;
  }
}
