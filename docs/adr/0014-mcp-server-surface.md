# ADR-0014 — An MCP server surface, PAT-authenticated, delegating to the existing chokepoint

- **Status:** Accepted — `McpModule` implemented as a third process (`src/mcp/main.ts`, run via
  `npm run mcp:dev`), advertising `search_evidence`, `get_answer`, and `request_resolution` as
  originally shipped, and deployed as an `mcp` service in `docker-compose.yml`'s `full` profile
  alongside the API and worker. **Amended by ADR-0020** (2026-08-24), which adds `ask_evidence` and
  `verify_claims` to this surface — every statement below counting "three" advertised tools, three
  `ToolDefinition`s, or two `STEP_MINIMUM_ROLE` entries describes the surface as it shipped at this
  ADR's own Accepted date, not as it stands now; the amendment notes inline mark exactly what
  changed.
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

The pilot's shape is "made AI-searchable through the sanctioned environment" — the platform has to
be reachable *from* a client's own AI tooling, not be one more destination app a person has to
remember to open. A REST API with a Swagger doc satisfies a human clicking through Postman; it does
not satisfy an AI assistant a user already trusts with other work, because that assistant has no
standard way to discover this platform's endpoints, authenticate to them, or interpret their
response shapes without bespoke integration code per client. The Model Context Protocol is the
closest thing to a standard for that discovery-and-invocation problem today, and this ADR is the
decision to expose a narrow MCP surface over the retrieval and answer-lookup capabilities this
codebase already has, rather than build a new integration per AI tool a client happens to use.

What this surface offers that a raw vector search cannot is the same thing the REST API's Q&A path
offers over a bare retrieval endpoint: verified, citation-checked evidence with locators, not
unverified snippets. `get_answer` returns an answer that has already passed
`GroundingGateService.verify` (ADR-0004) — every citation checked against retrieved chunk text,
every numeric claim checked against extracted facts — before an AI client ever sees it. An MCP
server that just wrapped `$vectorSearch` would hand a connected model the same unverified-snippet
problem this codebase built ADR-0004 to solve for its own served answers; wrapping the verified path
instead means a client's AI tooling inherits the same trust guarantee a human using the SPA gets.

## Decision

### `ToolExecutorService` stays the single validation and authz authority

`McpServerService.buildServer` routes every `tools/call` request through the same
`ToolExecutorService.execute` chokepoint (ADR-0005) that the since-removed
`AgenticRetrievalService` originally proved out — `toCallToolResult` maps a chokepoint refusal onto
the MCP wire shape (`isError: true`,
the refusal's own reason and detail as the text content) rather than a thrown protocol error, so a
caller gets an ordinary inspectable tool result either way. Nothing in `src/mcp/**` re-implements
argument validation, step allowlisting, or an authorization decision — `mcp-tools.ts` declares
`MCP_READ_STEP` (`stepId: 'mcp-read'`, allowing exactly `search_evidence` and `get_answer`) and
`MCP_MUTATE_STEP` (`stepId: 'mcp-mutate'`, allowing exactly `request_resolution` — kept disjoint
from `MCP_READ_STEP` so a read token and a mutating token stay distinguishable in policy), plus
three `ToolDefinition`s (`buildSearchEvidenceTool`, reused unchanged from
`agentic-retrieval-tools.ts`; `buildGetAnswerTool` and `buildRequestResolutionTool`, both new), and
hands every one to the same registration/execution path every other tool caller in this codebase
uses. `StepPolicyAuthzHook`'s `STEP_MINIMUM_ROLE` map grants `'mcp-read'` a `UserRole.Member` floor —
read-only evidence search and answer lookup performed on behalf of a caller who could already ask
the identical question through the REST API is not a capability worth gating behind a higher role
than asking the question requires in the first place. The map holds exactly two entries, `'mcp-read'`
and `'mcp-mutate'`; any step absent from it is refused by `authorize`'s fail-closed default rather
than granted. `'mcp-mutate'` is gated at `UserRole.Admin` — starting a workflow that writes an
`Approval` row is a step above asking a question, even though the write itself only ever proposes
(see § A proposing write is permitted; deciding one never will be, below).

> **Amended by ADR-0020.** The map now holds four entries, not two: `'mcp-ask'` (for `ask_evidence`)
> and `'mcp-verify'` (for `verify_claims`) join `'mcp-read'` and `'mcp-mutate'`, both floored at the
> same `UserRole.Member` as `'mcp-read'`. `mcp-tools.ts` now declares five `ToolDefinition`s, not
> three: `buildAskEvidenceTool` and `buildVerifyClaimsTool` join the three named above. The
> fail-closed default for a step absent from the map is unchanged — a step this codebase adds a
> tool for without an explicit `STEP_MINIMUM_ROLE` entry is still refused, not granted.

`execute()` builds the tool's execution context entirely from the token this process itself
verified (`context: ToolExecutionContext`, threaded in from `authenticate`) — never from anything
inside `request.params.arguments`, the one part of a `tools/call` request an AI client (or whatever
is upstream of it, including a prompt-injected document the client is reasoning over) actually
controls. `buildGetAnswerTool`'s handler is the concrete instance: `context.actorId`/
`context.tenantId` scope every lookup, `answerId` is the only argument a caller supplies, and a
cross-tenant `answerId` 404s exactly like a nonexistent one — no argument can widen which tenant's
answers a call can reach.

### PAT now, OAuth 2.1 later, behind the `TokenVerifier` seam

This surface authenticates with a personal access token (`Authorization: Bearer eo_pat_...`), not
the browser-session cookie `JwtAuthGuard` reads for the SPA. A cookie is scoped to a browser
session that established it through a login flow; an MCP client is a non-browser process (a
desktop AI tool, a CLI, another server) with no session to present a cookie from and typically no
interactive login flow to run through per call. A PAT — a long-lived credential the user
deliberately mints once (`ApiKeysService.mint`, `token-verifier.interface.ts`'s `TokenVerifier`
seam) and hands to their own AI tooling — is the shape that credential actually needs.

The alternative considered and rejected was minting an ordinary long-lived JWT for this purpose
instead of a dedicated token type. `JwtAuthGuard`'s JWTs are already short-lived by design, matching
the browser session they authenticate; stretching that same mechanism to live for months in a
third-party AI tool's config file, with no way to revoke one instance without invalidating every
session issued the same way, is a strictly worse credential than a PAT built to be revoked
individually (`ApiKeysService.revoke`, scoped to the specific key and its owning user). `PatTokenVerifier`
is deliberately thin — it extracts the bearer token and delegates verification to the injected
`TOKEN_VERIFIER` (`ApiKeysService` today), reshaping a `VerifiedIdentity` into a
`ToolExecutionContext`; it never re-implements verification itself. Only the token's sha256 hash is
ever stored (`ApiKeysService.hash`, `createHash('sha256')` — the plaintext exists only in the
`mint()` response, never persisted, never logged), and `role`/`tenantId` resolve from a live read of
the `User` row on every `verify()` call rather than from anything encoded into the token — a
demoted user loses MCP access the moment their role changes, not whenever their token happens to
expire.

`TOKEN_VERIFIER` is a seam specifically so a second implementation (OAuth 2.1, the standard MCP
itself is converging toward for production deployments) can bind to the same interface later with
no change to `PatTokenVerifier`, `McpServerService`, or anything downstream of `ToolExecutionContext`
— the seam's job is making that swap a new binding, not a rewrite.

### Stateless Streamable HTTP, a separate process

`src/mcp/main.ts` boots `McpModule` via `NestFactory.createApplicationContext` and layers a plain
`express()` app on top by hand — the same "DI slice mirroring `AppModule` minus HTTP-only concerns"
shape ADR-0003 established for `src/worker/main.ts`, with the same three-process arrangement (API,
worker, and now this) rather than folding MCP handling into the existing API process. Each `POST
/mcp` request gets its own `Server`/`StreamableHTTPServerTransport` pair, built with
`sessionIdGenerator: undefined` (the SDK's own stateless pattern) and closed on `res.close` — no
session persists between requests, so one caller's verified identity can never leak into another
request's tool calls through shared server state. `GET`/`DELETE` on the same route both 405, since
neither has a session to stream from or terminate in stateless mode.

Every request is gated in order before any MCP protocol work starts: `authenticate` (fails CLOSED —
a missing, malformed, revoked, or expired PAT never reaches `buildServer`, returning 401), then
`checkRateLimit` (fails CLOSED — a fixed-window limiter, 60 calls/minute by default
(`MCP_RATE_LIMIT_PER_MINUTE`), keyed by the verified `actorId`, held in-memory on the singleton
`McpServerService` rather than a shared store — correct for a single-replica deployment, a known
bound if this surface is ever run behind more than one instance, since counters would not be shared
across replicas).

### A proposing write is permitted; deciding one never will be

`ADVERTISED_TOOLS` is three entries: `search_evidence`, `get_answer`, `request_resolution`. (**Amended
by ADR-0020:** `ADVERTISED_TOOLS` now also includes `ask_evidence` and `verify_claims`, advertised
whenever `config.spend.dailyLimitUsd > 0` — neither is a write in the sense this section means;
both call a model but change no persisted state of their own the way `request_resolution` does.)
`request_resolution` writes — it starts a `resolveConflict` workflow execution and the `Approval`
row that gates it (`MCP_MUTATE_STEP`, `stepId: 'mcp-mutate'`, gated at `UserRole.Admin` — a
strictly higher floor than `MCP_READ_STEP`'s `Member`, so proposing a resolution is not reachable
at the same role the read-only tools are). That write is permitted precisely because everything it
does is *propose*: it never resolves a conflict itself, it only starts the same durable,
`ApprovalChannel`-backed wait `POST /conflicts/:id/resolution-requests` already starts
(`ConflictsService.requestResolution` is the one implementation both surfaces call), and nothing
downstream of that call runs until a human decides it through `ApprovalsService.decide()` — an
endpoint this process has no access to and no tool for.

This is still the most important line in this ADR, restated for what actually shipped rather than
for a boundary that turned out to be one tool narrower than first drawn: ADR-0009 built durable
human approval as a two-key control specifically because a decision that matters needs a human's
deliberate act to authorize it, re-derived from a Mongo row an authenticated HTTP endpoint wrote,
never trusted from a signal's payload alone. **No tool on this surface holds the second key.**
`request_resolution` can mint the first key — a pending `Approval` row and the workflow execution
waiting on it — but deciding that row is `ApprovalsService.decide()`'s job alone, reachable only
through the interactive REST/SPA path behind `JwtAuthGuard`, never through anything `McpModule`
registers. An MCP tool that let a connected AI client call `decide()` would collapse that control —
the surface that lets a model *propose* what to search for, and now what to resolve, would also be
the surface that gets to *approve* the outcome of a workflow waiting on a human, and the whole point
of ADR-0009's two-key design is that those are never the same actor. No future increment of this
surface should add a tool that reaches `decide()`, signals an approval-gated workflow directly, or
otherwise changes persisted state without going through a durable approval wait first, without
revisiting this decision explicitly — the never-decide boundary is not an oversight to fill in
later, it is the property that keeps this surface's role as "AI reads verified evidence and may
propose an action a human still has to authorize" from becoming "AI decides what the system does."

### The re-provide pattern, repeated

`McpModule` needs its own `ToolExecutorService` instance for the same structural reason the
since-removed agentic retrieval mode first ran into: `ToolExecutorService`'s constructor dependency (`TOOL_AUTHZ_HOOK`) is resolved in
whichever module declares the provider, so importing a module that merely uses the chokepoint does
not hand back an instance bound to a different, real policy — importing `AuthzModule` alone would
hand back its own default-deny instance. `QaModule` does not carry this pattern today:
`AgenticRetrievalService`, the caller that originally forced it to re-provide the chokepoint, was
removed along with agentic retrieval, and `QaModule` re-provides nothing
authz-related now — so `McpModule` avoids the same structural trap on its own account, not a live
one another module currently exhibits. `McpModule` declares both `ToolExecutorService` and `{ provide:
TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook }` directly in its own `providers`, giving this
process a second, independent `ToolExecutorService` instance with its own tool registry
(`search_evidence`, `get_answer`, `request_resolution` as originally shipped; `ask_evidence` and
`verify_claims` joined it per ADR-0020), constructed once in `McpServerService`'s own constructor.
`AuthzModule`'s default-deny binding, and every other module that resolves through
it, is untouched by this.

## Known bounds

1. **Rate limiting is per-process, in-memory.** `McpServerService.rateLimitWindows` is a plain
   `Map` on a singleton service. Correct for the single-replica deployment this ADR is written
   against; horizontally scaling this process would need a shared counter store (Redis or
   equivalent) for the limit to mean what its name says across replicas.
2. **PAT verification is a full `findOne` plus a `User` lookup per call, with no caching.** Every
   `tools/call` (and every `authenticate` before it) does two Mongo round-trips. Acceptable at the
   call volumes a rate-limited, per-actor MCP surface sees today; a future high-throughput client
   would be a reason to revisit, not a defect in the current design.
3. **No token-scoped tool restriction.** A PAT that meets a step's role floor can call every tool
   that step allows — there is no narrower-than-role scoping (e.g. "this token may only search,
   never propose a resolution"). `STEP_MINIMUM_ROLE`'s per-step floor (`Member` for `MCP_READ_STEP`,
   `Admin` for `MCP_MUTATE_STEP`) is the only granularity that exists today.

## Consequences

**Good.** A client's own AI tooling can reach this platform's verified retrieval and answer-lookup
capability through a protocol that tooling likely already speaks, without a bespoke integration
built per client. The same chokepoint, the same grounding gate, and the same tenant isolation this
codebase already built for its own served answers cover this surface too, because it delegates to
them rather than re-implementing anything — an MCP-specific security review is mostly a review of
`authenticate`/`checkRateLimit` plus three thin `ToolDefinition`s, not of a parallel access-control
system. (**Amended by ADR-0020:** now five `ToolDefinition`s, plus the spend gate that withholds two
of them when the tenant's daily ceiling is disabled — still a review of the same chokepoint, not a
parallel system, but a wider one than "three thin `ToolDefinition`s" states today.)

**Costs.** A third process to build, deploy, and operate, with its own PAT-issuance UI/flow burden
on `ApiKeysService`'s existing surface, and a protocol (Streamable HTTP, stateless mode) still young
enough that its production operational patterns are less established than a REST endpoint's. Every
new capability this platform wants to expose over MCP is a new `ToolDefinition` plus an explicit
addition to `STEP_MINIMUM_ROLE` — deliberately not automatic, so nothing becomes reachable from an
AI client by omission the way a REST route reachable by anyone with a session would be.

**Deferred, deliberately.** OAuth 2.1 support is not built — the `TOKEN_VERIFIER` seam exists so it
can be, but no second binding exists yet. Whether this surface should ever expose a tool that
*decides* an approval-gated action is not deferred — see § A proposing write is permitted; deciding
one never will be, above — but every other kind of extension, read-only (a document-listing tool, a
source-status tool) or a further proposing write behind its own durable approval wait, is a
plausible next increment not designed here.

Two of those extensions were load-bearing rather than optional, because of what the shipped surface
left unreachable. Of the three advertised tools, only `search_evidence` was invocable by a client
holding nothing but a PAT:

- **Starting a question is not on this surface, and a PAT cannot start one elsewhere.** An
  `answerId` is minted at `POST /api/v1/questions` (`QaService.startQuestion`) and nowhere else, and
  that route is behind `JwtAuthGuard`, which verifies a session JWT — a PAT is not one, so it 401s.
  `get_answer` therefore only works on an id a human obtained through the SPA or REST path and
  handed to the client out of band. A question-starting tool is the extension that closes this; its
  absence is the reason `get_answer`'s own description ends "this surface has no tool for that".
- **No MCP-reachable response carries a fact id.** `request_resolution` needs a `winningFactId`, but
  `search_evidence` returns `RetrievedChunk`s (chunk id, locator, text) and `get_answer`'s envelope
  cites evidence by `chunkId`, with its `conflicting_evidence` branch naming each side by
  `sourceChunkId` — a chunk, never the `ExtractedFact` behind it. Fact ids reach a caller only
  through the conflict-listing REST responses this surface does not expose, so the same out-of-band
  hand-off is required before the one write tool can be called at all. A conflict-listing read tool
  is the extension that closes this.

> **Amended by ADR-0020.** The first of those two extensions has shipped: `ask_evidence` mints an
> `answerId` directly from a PAT (`QaService.startQuestion`, the same method the REST route calls),
> so a client holding nothing but a PAT can now start a question and poll `get_answer` for it
> without a human in the loop. `get_answer`'s own description no longer ends "this surface has no
> tool for that" — it now reads "use `ask_evidence` for that, then pass the `answerId` it returns
> here." The second extension — a conflict-listing read tool closing the fact-id gap — has not
> shipped; `request_resolution` still needs a `winningFactId` obtained out of band, exactly as
> described above.

The honest consequence, as it stood at this ADR's own Accepted date: an MCP client alone could
exercise retrieval — evidence search over its tenant's corpus, ahead of the grounding gate, which
runs in the answer path this surface did not yet start — and little else. `get_answer` did return
gate-verified answers with citations, and `request_resolution` did start a real durable approval,
but both were reachable only in a human-plus-client workflow where a person supplied the id. That
was a narrower "AI-searchable" claim than three advertised tools suggested. **This is no longer
current** (ADR-0020): a client holding only a PAT can now start a question, poll it to completion,
and separately have its own drafted claims checked against the corpus — the fact-id gap is the one
piece of the original honest-consequence paragraph still true today.

Also absent by omission rather than by design: `fetch_chunks`, the since-removed agentic loop's
companion to `search_evidence`, is neither registered on this process's `ToolExecutorService` nor
allowed by `MCP_READ_STEP`. The loop truncates search results to a preview precisely because
`fetch_chunks` can re-read a chunk in full; with no such tool here, the MCP handler serializes the
retrieval result as it stands, so an MCP caller receives full chunk text from `search_evidence`
itself. That is what the tool's MCP-facing description states.

## Interview framing

> The line I'd draw first, before anything about the protocol: this surface can propose, but it can
> never decide, and the reason isn't caution for its own sake — it's that the approval workflow I
> built earlier (ADR-0009) is a two-key control specifically so the thing proposing an action is
> never the same actor as the thing approving it. `request_resolution` holds the first key — it can
> start a workflow and the `Approval` row gating it — but deciding that row is `ApprovalsService
> .decide()`'s job alone, and nothing on this surface reaches it. Putting a decide-the-conflict tool
> on an AI-reachable surface would collapse that split, so there isn't one, and there won't be one
> without revisiting this decision explicitly. Second: I didn't build a new authorization system for
> this — `tools/call` routes through the exact same chokepoint the agentic retrieval loop uses, so
> this surface inherited deny-by-default tool execution and tenant-scoped context for free, and the
> only thing genuinely new here is authenticating a non-browser client with a revocable PAT instead
> of the session cookie the SPA uses, and gating the one write tool at a higher role floor than the
> read-only ones. And I'd be upfront about the honest bet underneath all of it: MCP is the
> highest-probability integration surface for "made AI-searchable" — independently worth building for
> the portfolio and learning value alone — but whether it's the *right* surface for a specific
> client's actual AI environment is a discovery question I don't have an answer to yet, and I'm not
> going to overclaim one.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the verification `get_answer` exposes
  the result of, never re-implements.
- `docs/adr/0005-deterministic-authz-and-tool-chokepoint.md` — the chokepoint this surface delegates
  every tool call to.
- `docs/adr/0009-durable-human-approval-gates.md` — the two-key control this surface's never-decide
  boundary exists to keep intact.
- `docs/adr/0020-attestation-surface.md` — **amends this ADR.** Adds `ask_evidence` and
  `verify_claims`, closing the question-starting gap this ADR's Consequences section originally
  named as load-bearing, and records the new `mcp-ask`/`mcp-verify` steps, tool count, and spend
  gate the inline amendment notes above point back to.
