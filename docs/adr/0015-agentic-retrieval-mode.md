# ADR-0015 — Agentic retrieval mode: the loop gathers, it never answers

- **Status:** Superseded (2026-08-18) — `AgenticRetrievalService`, the `retrieveEvidenceAgentic`
  activity, the `answer-question` workflow's strategy branch, and the config vars
  `RETRIEVAL_STRATEGY` / `AGENTIC_MAX_ITERATIONS` / `AGENTIC_MAX_COST_USD` are removed from the
  codebase. Two reasons: the mode duplicates a capability an enterprise buyer can already purchase
  (Claude Enterprise, Hebbia), and with the loop gone the model-side tool-calling plumbing it alone
  exercised (`ModelRequest.tools`, `ModelResult.toolCalls`/`stopReason`, the `'tool'` message role,
  both vendor tool-mapping paths) had zero remaining production callers. `searchEvidenceToolDefinition`
  and `buildSearchEvidenceTool` survive the removal, relocated to
  `src/features/evidence/retrieval/evidence-tools.ts`, where they still serve the MCP surface
  (ADR-0016) — this ADR's design rationale and the three config defaults below are kept as the
  historical record of a mechanism that shipped, was verified safe, and was later decided not worth
  the standing maintenance cost.
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

`EvidenceRetrievalService.retrieve` (ADR-0002) runs one hybrid search per question and hands
whatever it finds to synthesis. That is correct for a query the corpus can answer in one search,
and blind to a query that needs a second search informed by what the first one turned up — a
number found in one document that only makes sense once a related document is also pulled in, say.
The obvious way to close that gap is to let a model decide what to search next, informed by prior
results, before synthesis runs. The obvious way to get that wrong is to let the model's own text
become the evidence a citation gets checked against — exactly the trust ADR-0004's grounding gate
and ADR-0005's tool chokepoint both exist to withhold from model output. This ADR is the design
that lets a model drive multi-turn search without ever being the thing that produces a
`RetrievedChunk`.

## Decision

### Two phases, and the boundary between them is the safety property

Phase one, `AgenticRetrievalService.gatherEvidence`: a loop where a model call chooses a tool
(`search_evidence` or `fetch_chunks`), the server executes it through `ToolExecutorService`
(ADR-0005's chokepoint, step `'agentic-retrieval'`), and the *real result* of that execution — not
anything the model said about it — is what gets accumulated. Phase two is unchanged: the resulting
`chunks` array is handed to `SynthesisService.synthesizeAnswer` and `GroundingGateService.verify`
exactly as `EvidenceRetrievalService.retrieve`'s single-shot output already was, in the same
`answerQuestion` workflow (`answer-question.workflow.ts`), through the same activity contract
(`SynthesizeAnswerActivityInput`/`GroundingCheckActivityInput` never changed shape for this).

The loop's only job is gathering. It cannot answer the question itself — the system prompt says so
(`buildSystemPrompt` in `agentic-retrieval.service.ts`), but that instruction is not what makes it
true. What makes it true is that `gatherEvidence` never reads the model's free-text `output` field
into `chunks` at all: every entry in the `gathered` map is written by
`AgenticRetrievalService.executeToolCall`, from the tool's own return value
(`toolResult.result as RetrievedChunk[]` for `search_evidence`, chunks resolved from `seenChunks`
for `fetch_chunks`), never parsed out of anything the model wrote in its message content. A model
that includes a chunk-shaped JSON blob in its response text — the shape an injected instruction in
a malicious document might try to produce, given that every tool result is fenced and handed back
to the same model on the next turn — has no path from that text into `gathered`, because nothing in
the loop ever looks at `result.output` for chunk data. `agentic-retrieval.service.spec.ts`'s test
"should never fabricate a chunk from model text" is the concrete check: it stubs the model provider
to return a chunk-shaped JSON string (`chunkId: 'fabricated'`, `text: 'INJECTED_MARKER'`) as
`output` with no tool call at all, and asserts `gathered` stays empty.

This is why "the gate is unchanged" is a structural claim, not a promise about what the gate
happens to do today. `GroundingGateService.verify` was not touched, extended, or branched for this
mode — it takes a `RetrievedChunk[]` and verifies claims against it, and it has no way to tell
whether that array came from one hybrid search or eight tool-mediated turns. The only thing that
changed is how the array got assembled before synthesis ever saw it; the verification step
downstream of that array is identical code running against identical input shapes either way. That
identity is also what makes an eval comparison between the two modes fair: retrieval strategy is
the only variable that differs between a single-shot run and an agentic run of the same question,
because synthesis and grounding are the same code path for both.

### `fetch_chunks` performs no lookup of its own

`buildFetchChunksTool`'s handler (`agentic-retrieval-tools.ts`) is `async (args) => args` — it
validates `ids` against the chokepoint's strict zod schema and returns them unchanged. The actual
resolution happens back in `AgenticRetrievalService.executeToolCall`, which looks each validated id
up in `seenChunks`, a map populated only by prior `search_evidence` results *in the same
`gatherEvidence` call*. An id that never appeared in this loop's own search results comes back as
`missing`, reported to the model as an unknown chunkId, never as a lookup against the tenant's full
corpus. `fetch_chunks` cannot be used to pull an arbitrary chunk by a guessed or leaked id —
structurally, not by convention, because there is no code path in the tool that touches storage at
all.

One distinction worth being precise about, since `search_evidence` and `fetch_chunks` both write
into `gathered`: `gathered` receives every chunk a `search_evidence` call returns the moment that
call executes, before the model ever decides whether to `fetch_chunks` it. `fetch_chunks` re-adds
the same already-gathered chunks from `seenChunks` — a model that never calls it loses nothing from
what synthesis receives, only the chance to read a chunk's full text (past the 320-character
preview `formatSearchResults` sends inline) before deciding whether to search again. `fetch_chunks`
changes what the model can read mid-loop; it never changes what synthesis is handed.

### Budget semantics: one shrinking ceiling, not two

`gatherEvidence` tracks `spentUsd` against `config.agenticRetrieval.maxCostUsd` (env
`AGENTIC_MAX_COST_USD`, default `1`) as its own running total, and each turn's own `maxCostUsd` is
`Math.min(PER_TURN_MAX_COST_USD, totalBudgetUsd - spentUsd)` — `PER_TURN_MAX_COST_USD` is a
hardcoded `0.25`, a ceiling on any single turn regardless of how much of the total remains, not a
second budget. That composed number is what actually reaches `ModelProvider.generate`, which
enforces it through the provider's own `assertBudget` — the same fail-closed spend guard every
other model call in this codebase goes through, not a parallel mechanism invented for this loop. A
proactive check (`remainingUsd <= 0` before calling `generate` again) and a reactive one
(`ModelBudgetExceededError` caught and treated as exhaustion, never rethrown) both terminate the
loop the same way: exhaustion degrades to synthesis-over-whatever-was-gathered, it never surfaces
as an error to the caller. `config.agenticRetrieval.maxIterations` (env `AGENTIC_MAX_ITERATIONS`,
default `8`) is the other independent ceiling — either one running out ends the loop; neither
depends on the other.

### The small-corpus caveat, stated plainly

Iterative search earns its keep on a large, heterogeneous corpus, where a first query surfaces one
relevant document and a second, model-chosen query — informed by what the first one found — reaches
a second document a single hybrid search would have missed. The demo corpus this platform runs
against today is small. On a handful of documents, a single well-formed hybrid search may already
surface everything a second search would have found, in which case agentic retrieval spends more
(extra model turns, each with its own cost and latency) to reach the same `chunks` set single-shot
retrieval reaches in one call. This ADR does not claim agentic retrieval measurably improves answer
quality on this corpus — it claims the mechanism is correct and safe to turn on. **The eval decides
that question, not the design intent stated here.** `eval/retrieval/gather-evidence-for-strategy.ts`
is the harness lane that runs both strategies over the same question set for comparison; a result
showing agentic retrieval is no better, or better but materially more expensive in latency and
model spend, is a legitimate outcome of that comparison and should be published as such rather than
treated as a failure to explain away.

### The authorization trap this hit, because it will recur

`AgenticRetrievalService` was built, registered its tools, and passed a green test suite while
every one of its tool calls was silently refused. `ToolExecutorService` is a plain `@Injectable`
with a constructor dependency on `TOOL_AUTHZ_HOOK` (ADR-0005); Nest resolves a provider's
constructor dependencies in whichever module *declares* that provider, not in the module that later
injects it. `QaModule` needed `ToolExecutorService` bound against a real policy
(`StepPolicyAuthzHook`, not `AuthzModule`'s default-deny `DenyAllAuthzHook`), and importing
`AuthzModule` to get there does not do that: `AuthzModule` already constructs its own
`ToolExecutorService` instance against its own `DenyAllAuthzHook` binding, and importing that
module only hands `QaModule` the same already-built, already-deny-all instance. The fix
(`qa.module.ts`'s own comment records the present-tense reasoning) is that `QaModule` declares
*both* `ToolExecutorService` and its `TOOL_AUTHZ_HOOK` binding directly in its own `providers`
array, giving it a second, independent `ToolExecutorService` instance constructed against
`StepPolicyAuthzHook` — `AuthzModule`'s own binding, and everything else in the app that resolves
through it, stays untouched.

Before that fix, every `search_evidence`/`fetch_chunks` call reached `ToolExecutorService.execute`,
was refused at gate three (`authz-denied`, `DenyAllAuthzHook`'s stated reason), and that refusal was
fed back to the model as an ordinary tool result — the loop kept running, produced `no-tool-call` or
`iteration-cap` termination with an empty `chunks` set, and synthesis correctly reported
`insufficient_evidence` on zero evidence. Nothing threw. Nothing looked different from a genuinely
empty corpus. A test asserting "agentic retrieval on an empty corpus returns
`insufficient_evidence`" would have passed against a fully-refused run for the wrong reason.

The generalizable lesson: opting a module into a chokepoint service that carries its own injected
policy requires re-providing *both* the service and the policy binding together in that module, not
rebinding the token alone — and a authorization refusal that degrades identically to "found
nothing" is indistinguishable from an empty corpus unless something counts refusals separately.
`AgenticRetrievalService.gatherEvidence` now does exactly that:
`AgenticRetrievalTerminationReason` includes `'all-tool-calls-refused'`, which overrides whichever
of the other three reasons the loop would otherwise have reported whenever at least one tool call
was attempted and every attempted call was refused (`toolCallCount > 0 && refusedToolCallCount ===
toolCallCount`), logged as a warning naming the step id. `McpServerService` (ADR-0016) repeats the
identical re-provide pattern in its own module, for its own reason: reusing `QaModule`'s instance
there would mean a shared tool registry, and `registerTool` throws on a duplicate name — `McpServerService`
registering `search_evidence` a second time against an already-populated registry would fail at
construction, not silently deny at call time the way the deny-all default did here.

### Default is single-shot; agentic is opt-in per deployment

`RETRIEVAL_STRATEGY` (env, `z.enum(['single-shot', 'agentic']).default('single-shot')`) is a
deployment-level setting, not a per-question or per-user choice — `answerQuestion` branches on
`input.retrievalStrategy` alongside `input.actorId`/`input.role` (both required together, since the
agentic branch needs a real `ToolExecutionContext` to present to the chokepoint), but every one of
those three fields is populated by `QaService.startQuestion` from `this.config.retrieval.strategy`
and the requesting user, never from a request body field a caller controls per call. An ordinary
question asked today, on an unconfigured deployment, takes the single-shot path unchanged.

## Consequences

**Good.** A model can now drive multi-turn search — informed by what an earlier turn found — without
ever being trusted to produce the evidence a citation is checked against; the trust boundary sits at
`ToolExecutorService.execute`'s real tool results, not at anything the model says about them. The
grounding gate and synthesis needed zero changes to support this mode, which is itself the evidence
that the two-phase split holds: nothing downstream of `chunks` had to be told which retrieval
strategy produced it. The eval harness can compare the two strategies on identical questions because
retrieval is the only variable that differs between them.

**Costs.** An agentic run costs more than a single-shot one by construction — up to
`maxIterations` model turns plus a Voyage embedding call per `search_evidence` invocation, against
single-shot's one hybrid search — and that cost is paid even on questions a single search would have
answered, until the eval comparison says otherwise for a given corpus shape. The loop's own budget
math (`PER_TURN_MAX_COST_USD` hardcoded at `0.25`, not a config value) is a fixed ceiling picked to
be small relative to `SynthesisService`'s own token budget, not a value tuned against measured turn
costs; a corpus or model where a realistic tool-selection turn costs meaningfully more than that
ceiling would see turns clipped before they can complete.

**Deferred, deliberately.** No live comparison result exists yet — the eval lane
(`eval/retrieval/gather-evidence-for-strategy.ts`) is built to produce one, but this ADR is written
before that data exists, on purpose: the mechanism had to be correct and safe to turn on regardless
of what the comparison eventually shows, and recording the design ahead of the result keeps the two
questions ("is this safe" and "is this worth it") from getting conflated.

## Interview framing

> The thing I'd point at first is where the trust boundary actually sits. The model chooses what to
> search for, turn after turn, but it never gets to say what the evidence was — every chunk that
> reaches synthesis was written into the gathered set by the server's own tool execution, never
> parsed out of the model's response text. I have a test that proves that directly: feed the model a
> chunk-shaped JSON string with no tool call behind it, and the gathered set stays empty. The second
> thing is a bug I'd be honest about rather than skip past: the loop shipped fully wired and fully
> inert, because the tool chokepoint it called into was bound to a deny-all policy by default and the
> refusal degraded silently into "found nothing" — a green test suite the whole time. Fixing it
> wasn't a policy change, it was a DI wiring fix (a module has to re-provide the chokepoint service
> *and* its policy binding together, not just rebind the policy token), plus a new termination reason
> so a fully-refused run is never silently indistinguishable from an empty corpus again. And the
> honest caveat I'd volunteer before anyone asks: the demo corpus is small enough that a single good
> search may already find everything, so I'm not claiming this measurably improves answers here — I'm
> claiming it's safe to turn on, and letting the eval comparison decide the rest.

## Related

- `docs/adr/0002-single-store-hybrid-retrieval.md` — the single-shot retrieval this mode is an
  opt-in alternative to, never a replacement of.
- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the verification step this ADR's
  two-phase split leaves structurally unchanged.
- `docs/adr/0005-deterministic-authz-and-tool-chokepoint.md` — the chokepoint this mode is the
  first real caller of, and whose Status line ("not yet wired into the Q&A path") this ADR
  supersedes in practice, though that line is left as written there rather than edited here.
- `docs/adr/0016-mcp-server-surface.md` — the second module that hits, and independently fixes, the
  same re-provide requirement this ADR's authorization-trap section describes.
