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
  MCP_RATE_LIMIT_SWEEP_BATCH_SIZE,
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

/** Returned to the MCP client in place of anything a tool handler (or the audit write around it)
 *  throws — mirrors `GlobalExceptionFilter`'s and the SSE streams' withheld-detail text
 *  (`SSE_STREAM_ERROR_MESSAGE`) so a Mongo duplicate-key message, a validation error, or any other
 *  exception this process did not itself construct as a refusal never reaches this surface
 *  verbatim, regardless of the thrown value's type. The real error is logged server-side wherever
 *  this constant is returned. */
const MCP_TOOL_HANDLER_ERROR_RESULT: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Internal server error' }],
};

/** One admitted charge against a rate-limit budget: the instant it was granted and the units it
 *  consumed. A charge counts against every window-length interval containing its instant, and is
 *  dropped once a full window has passed since. */
interface RateLimitCharge {
  readonly at: number;
  readonly cost: number;
}

/** Backing store for one rolling-window limiter: the charge log by key, plus the amortised
 *  sweep's position within it. `cursor` persists on the store across calls so each call's sweep
 *  resumes where the previous one left off rather than restarting at the map's first key — see
 *  `sweepExpiredBatch`'s own doc comment for why a persistent cursor is what keeps a call's own
 *  cost from scaling with `charges.size`. */
interface RollingWindowStore {
  readonly charges: Map<string, RateLimitCharge[]>;
  cursor: IterableIterator<[string, RateLimitCharge[]]> | null;
}

function createRollingWindowStore(): RollingWindowStore {
  return { charges: new Map(), cursor: null };
}

/** Drops `key`'s own charges older than `cutoff` and deletes the key if none survive — run
 *  unconditionally against the key a call is deciding admission for, since that decision needs an
 *  accurate `spent` regardless of whether the amortised sweep below has reached this key yet. */
function evictExpiredForKey(
  charges: Map<string, RateLimitCharge[]>,
  key: string,
  cutoff: number,
): void {
  const entries = charges.get(key);
  if (entries === undefined) {
    return;
  }

  // Appended in call order, so the expired charges are a prefix and the scan stops at the first
  // survivor rather than walking the whole log.
  while (entries.length > 0 && entries[0].at <= cutoff) {
    entries.shift();
  }
  if (entries.length === 0) {
    charges.delete(key);
  }
}

/**
 * Evicts stale entries from up to `MCP_RATE_LIMIT_SWEEP_BATCH_SIZE` keys per call, resuming from
 * `store.cursor` rather than restarting — the bound that keeps this bookkeeping O(1) per call
 * instead of O(`store.charges.size`). A map iterator visits keys present when each step runs: a
 * key deleted before its turn is skipped without error, and a key added during the sweep (by this
 * or a concurrent call sharing the same store) is still reached on a later step, so neither
 * mutation invalidates the cursor. The cursor resets to `null` once a full pass completes, so the
 * next call starts a fresh pass rather than an empty, permanently-exhausted iterator.
 *
 * This is what keeps `store.charges` bounded to currently active keys rather than growing for as
 * long as the process has been up — the property `rateLimitCharges`'s own field comment states —
 * without the whole-map walk on every call that made that boundedness cost O(active keys) per
 * request. An abandoned key waits at most `ceil(store.charges.size / MCP_RATE_LIMIT_SWEEP_BATCH_SIZE)`
 * calls to be reclaimed rather than the one call a full sweep took; a key still receiving traffic
 * cleans up its own log inline via `evictExpiredForKey` regardless of where the cursor is.
 */
function sweepExpiredBatch(store: RollingWindowStore, cutoff: number): void {
  const { charges } = store;
  if (store.cursor === null) {
    store.cursor = charges.entries();
  }

  for (let visited = 0; visited < MCP_RATE_LIMIT_SWEEP_BATCH_SIZE; visited += 1) {
    const next = store.cursor.next();
    if (next.done) {
      store.cursor = null;
      return;
    }

    const [chargeKey, entries] = next.value;
    while (entries.length > 0 && entries[0].at <= cutoff) {
      entries.shift();
    }
    if (entries.length === 0) {
      charges.delete(chargeKey);
    }
  }
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
 * `ConflictsService.requestResolution` only reads Mongo (the conflict, the built-in metric
 * ontology) and calls `workflowEngine.start`, which enqueues the `resolveConflict` workflow
 * without waiting for it — any model spend that workflow's own activities might later incur
 * happens on a Temporal worker process, outside this call and outside this gate's reach.
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
  /** Rolling-window charge log, keyed by the verified `actorId` — a caller with multiple PATs
   *  cannot multiply their own budget, and one tenant's callers cannot starve each other. Held on
   *  the singleton service, not the per-request `Server`, since a `Server` this class returns
   *  lives only as long as one stateless HTTP request. In-memory and per-process: correct for a
   *  single-replica surface with no shared counter store, not for horizontal scale-out.
   *  `applyRollingWindow` evicts the key under check inline and amortises eviction of every other
   *  key across calls (`sweepExpiredBatch`), so this stays bounded to currently active actors
   *  rather than growing for as long as the process has been up, without a whole-map walk on every
   *  call; within a key the surviving charges sum to at most the limit and each costs at least one
   *  unit, so a key holds at most `limit` of them and a refused call stores nothing at all.
   *  Distinct from `preAuthIpRateLimitCharges` below: this map only ever sees a caller who already
   *  holds a live PAT. */
  private readonly rateLimitCharges = createRollingWindowStore();

  /** Same rolling-window shape as `rateLimitCharges`, keyed by caller IP instead of `actorId` —
   *  `checkPreAuthIpRateLimit` reads it, called from the request handler before `authenticate`, so
   *  an unauthenticated flood is bounded before it ever reaches `PatTokenVerifier.verify` (a Mongo
   *  lookup per call). The two limiters coexist deliberately: this one polices callers with no
   *  verified identity yet, `rateLimitCharges` polices verified callers by budget. Its own
   *  bookkeeping staying O(1) per call — rather than O(active keys), as it was before
   *  `sweepExpiredBatch` — is what this map most needs: it is read on the unauthenticated path,
   *  before a caller has paid for even a `PatTokenVerifier.verify` lookup, so a high-cardinality
   *  flood of distinct IPs is exactly the load this map is built to survive. */
  private readonly preAuthIpRateLimitCharges = createRollingWindowStore();

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
   * Rolling-window limiter: `true` once the caller has budget for `cost` more units, up to
   * `config.mcp.rateLimitPerMinute` in every `MCP_RATE_LIMIT_WINDOW_MS`-wide interval per
   * `actorId`, `false` once granting `cost` would exceed that budget. `cost` defaults to `1` — a
   * plain single-message POST charges exactly what it always has — but a caller charges the actual
   * `countRateLimitCost` of one HTTP POST's JSON-RPC body, so a batch of N requests spends N units
   * in one call rather than the one unit the transport-level HTTP request would otherwise cost.
   * Fails CLOSED — there is no branch that defaults to allowing a call; a caller with no prior
   * charges still refuses when `cost` alone exceeds the budget, and a batch that would exceed the
   * *remaining* budget is refused wholesale rather than partially admitted.
   */
  checkRateLimit(actorId: string, cost = 1): boolean {
    return this.applyRollingWindow(
      this.rateLimitCharges,
      actorId,
      cost,
      this.config.mcp.rateLimitPerMinute,
      MCP_RATE_LIMIT_WINDOW_MS,
    );
  }

  /**
   * IP-keyed counterpart to `checkRateLimit`, gating the request handler *before* `authenticate`
   * runs — the actor-keyed limiter above only ever sees a caller who already holds a live PAT, so
   * without this an unauthenticated flood is never limited at all while each request still pays
   * for a `PatTokenVerifier.verify` lookup. Budget is `config.mcp.preAuthIpRateLimitMaxRequests` in
   * every `config.mcp.preAuthIpRateLimitWindowMs`-wide interval per IP; `cost` is always `1` since
   * a caller with no verified identity yet cannot present a JSON-RPC batch this surface trusts to
   * size a request. Fails CLOSED for the same reason `checkRateLimit` does.
   *
   * `ip` is whatever `req.ip` resolved to, which the `trust proxy` hop count decides
   * (`createMcpHttpApp`): too few hops merges callers into one bucket and over-refuses, too many
   * lets a caller spoof its own key. The bucket a caller lands in is that setting's concern; that
   * a bucket cannot be overspent is this method's.
   */
  checkPreAuthIpRateLimit(ip: string): boolean {
    return this.applyRollingWindow(
      this.preAuthIpRateLimitCharges,
      ip,
      1,
      this.config.mcp.preAuthIpRateLimitMaxRequests,
      this.config.mcp.preAuthIpRateLimitWindowMs,
    );
  }

  /**
   * Shared rolling-window admission check behind both limiters above, holding one property: for
   * any key and any instant `t`, the units admitted in `[t, t + windowMs)` never exceed `limit`. A
   * counter anchored at a key's first request holds the weaker property — it admits up to twice
   * the limit across an anchor boundary, since a budget spent just before the anchor elapses is
   * returned in full milliseconds later — so admission is decided against the individual charges
   * still inside the window rather than against a single count.
   *
   * Bounded in the same two ways a counter is, but not by a whole-map walk: `evictExpiredForKey`
   * evicts the key under check inline, so the admission decision below always sees an accurate
   * `spent` for that key, and `sweepExpiredBatch` reclaims every other key across an amortised
   * series of calls rather than all of them on this one — see that function's own doc comment for
   * why the combination keeps a map keyed by a high-cardinality caller identity (an actor id, or an
   * IP under a flood) bounded to currently active keys without this call's own cost scaling with
   * how many there are. Within a key, surviving charges sum to at most `limit` and each costs at
   * least one unit, so a key holds at most `limit` of them; a refused call stores nothing, so a
   * caller who is refused before ever succeeding leaves nothing behind to evict.
   *
   * Fails CLOSED on `cost` over its whole numeric domain, not only its non-positive values: only a
   * finite positive integer reaches the admission check below. Every other value the type allows —
   * `0`, a negative number, a fraction, `NaN`, `Infinity`, `-Infinity` — is refused outright.
   * `spent + cost > limit` alone only rejects part of that domain (`spent + Infinity` is `> limit`,
   * but `spent + NaN` is neither `>` nor `<=` anything, so a `NaN` charge would be admitted for
   * free and then poison the key: every later comparison against a `NaN`-bearing running total is
   * also `false`, admitting every further charge against that key regardless of budget). A
   * fractional cost would pass the admission check too, but breaks the bound the class comment
   * above promises — "each costs at least one unit" — by admitting more than `limit` charges. None
   * of this is reachable through either public method today (`countRateLimitCost` floors at `1`,
   * `checkPreAuthIpRateLimit` hardcodes `1`), but the guard holds over the signature it declares,
   * not over today's callers.
   */
  private applyRollingWindow(
    store: RollingWindowStore,
    key: string,
    cost: number,
    limit: number,
    windowMs: number,
  ): boolean {
    if (!Number.isInteger(cost) || cost <= 0) {
      return false;
    }

    const now = Date.now();
    // A charge at exactly `cutoff` has had a full window pass since, so it leaves — which is what
    // makes the interval this limiter bounds half-open, `[t, t + windowMs)`.
    const cutoff = now - windowMs;
    const { charges } = store;

    evictExpiredForKey(charges, key, cutoff);
    sweepExpiredBatch(store, cutoff);

    const entries = charges.get(key) ?? [];
    const spent = entries.reduce((total, charge) => total + charge.cost, 0);
    if (spent + cost > limit) {
      return false;
    }

    entries.push({ at: now, cost });
    charges.set(key, entries);
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
   * `finally` before the result goes back, so a failed audit write still replaces whatever the
   * handler produced with `MCP_TOOL_HANDLER_ERROR_RESULT` — the same fixed result a handler throw
   * itself gets — via the outer `catch` below, rather than either disclosing the handler's result
   * with no record of the call or letting the audit write's own error reach the client verbatim.
   */
  buildServer(context: ToolExecutionContext): Server {
    const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.advertisedTools.map(toMcpTool),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: toolArgs } = request.params;

      try {
        return await this.als.run(
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
              return toCallToolResult(executed);
            } catch (error) {
              // A handler's own throw (a Mongo duplicate key, a Mongoose validation error, an
              // unexpected `BaseException`, a thrown non-Error value) is the tool's own failure, not
              // a chokepoint refusal — `ToolExecutorService.execute` leaves it to propagate rather
              // than folding it into a `ToolExecutionRefusal`. This process has neither
              // `GlobalExceptionFilter` nor the SSE streams' `catchError`, so this is the only place
              // standing between that throw and the client; without it the error's own message (and,
              // for a Mongo duplicate key, its `code`) would reach the caller verbatim.
              this.logger.error(
                `Tool call for "${name}" threw: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error.stack : undefined,
              );
              return MCP_TOOL_HANDLER_ERROR_RESULT;
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
      } catch (error) {
        // Catches what the inner `catch` above cannot: chiefly the audit write itself throwing
        // inside that `finally` block, which supersedes the inner block's return value and would
        // otherwise carry its own message — a Mongo error, if the audit write is what failed —
        // straight to the client with no wrapping at all.
        this.logger.error(
          `Tool call for "${name}" failed outside the handler boundary: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        return MCP_TOOL_HANDLER_ERROR_RESULT;
      }
    });

    return server;
  }
}
