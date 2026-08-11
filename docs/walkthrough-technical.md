# Technical walkthrough — five minutes

A script to say aloud. Numbers come from
`eval/results/ee110642cc0b949a83e2da0a2dc712f602d4ab46-dirty.md`.

## 0:00–0:45 — The governing idea, and the three places it is enforced

The system answers questions over a document data room, and one idea runs through all of it: the
model proposes, the application disposes. That is three structural decisions, not a slogan.

First, the schema the model's output is constrained to has no `claimCoverage`, no
`verificationReport`, no `droppedClaims`. Those live in a server-side envelope the model never sees,
so forging its own verification result is not caught, it is ungrammatical — the schema is a
capability boundary. Second, a citation the model emits carries only a `chunkId` and a `quote`; the
document version, content hash and locator are resolved server-side from the chunk actually
retrieved, so there is no forgery surface. Third, the grounding gate between the model and the user
can only subtract. It calls no model and adds nothing, and its checks — was this chunk retrieved for
this request, does the quote appear verbatim in it, is every number in the claim supported — fail
closed at claim granularity. A component whose only power is to drop cannot hallucinate, which is
why I am willing to put it in that position.

## 0:45–1:30 — Three design decisions, quickly

Retrieval is lexical and dense in one MongoDB store, fused by reciprocal rank fusion. Fusing ranks
rather than scores matters because BM25 is unbounded and corpus-dependent while cosine similarity is
bounded and clustered — adding them silently elects one pipeline, and the winner changes on an index
rebuild. RRF keeps only each pipeline's ordering, so it survives any rescaling of either signal.
Tenant scoping runs inside both input pipelines, never on the fused output — post-filtering ranks a
set you then discard, changing the final top-k.

Workflow orchestration is deterministic Temporal code and every side effect is an activity, enforced
twice: an ESLint import zone as the fast CI signal, and the webpack bundler inside `Worker.create`,
which is the gate that holds. A linter sees only the imports in front of it; the bundler resolves the
whole module graph and catches a forbidden import reached transitively — the shape the failure
actually takes.

In the tool chokepoint, four gates run in a deliberate order — registry membership, the step's
allowlist, the authorization hook, then strict argument validation — so access is decided on tool
identity and step context before anything parses the untrusted arguments. A hook that throws is a
refusal, and the decision must be the literal `true`, because `{ allowed: 'yes' }` is truthy.

## 1:30–3:15 — What actually went wrong

Several real defects were invisible to a green suite at a hundred percent branch coverage, and
surfaced only when something real ran.

Anthropic rejects `$defs` under `anyOf`, and the SDK helper hoisted my three-way union into `$defs` —
meaning synthesis had never once executed against the live model. That same run showed the citation
contract demanding a 64-hex `sha256` and a structured locator the evidence fence structurally cannot
supply, so the model invented them; the fix was to split the contract, not to add a check. The
Temporal worker could never boot, because `tsx` omits `emitDecoratorMetadata` and Nest injected
`undefined` into every provider — the proof was a workflow sitting at two history events for ten
minutes with nothing polling. The replay cache could never hit, because the prompt embeds chunk ids
and those were per-run ObjectIds; the ADR's central claim, that CI replays the eval at zero cost, was
false. And content-addressing those ids to fix it broke tenant isolation — identical bytes under two
tenants derived the same `_id`, which the live integration suite caught as a duplicate-key error.

The honest lesson is the one I would lead with: coverage measured that lines executed under mocks,
not that the system worked. Every one of those defects lived exactly where a fake provider, a mocked
DI graph, or a hand-made 24-character fixture id stood in for the real thing.

## 3:15–4:15 — What it measures

Thirty-two cases: twelve answerable, eight unanswerable, five conflicting, seven adversarial. Recall
at five is 82.6%, MRR 0.653, citation precision 85.7%, mean claim coverage 92.2%. Abstention accuracy
is 100% — all eight unanswerable questions abstain rather than fabricate. The canary own-voice leak
rate is a hard gate at zero and passes. Three cases fail, all of them conflict cases.

Two caveats before you ask. In the retrieval-mode comparison, pure vector beats hybrid at recall@10 —
91.3% against 82.6% — so on this small synthetic set hybrid is not yet a win and I will not claim it
is. And these numbers predate the tenant-scoping fix, which invalidated the cache; a re-record is
pending, and the `-dirty` label exists so a results file cannot misidentify the code behind it.

## 4:15–5:00 — Where it is weak

Conflict recall is 40%, the weakest capability: prose fact extraction varies run to run, and sampling
cannot be pinned on this model tier — the API rejects a temperature parameter outright — so what
replay stabilises is the measurement, not the pipeline. Authorization is authentication plus a
constant tenant; `tenantId` is threaded through schemas, retrieval pipelines and activities so
enforcing it later is an index-and-filter change, but nothing derives a tenant from the authenticated
user and answer reads carry no owner predicate. The tool chokepoint has no caller yet — it exists so
that when one is wired, refusal is what it inherits. And telemetry is a logger behind an interface:
no OpenTelemetry, no exporter, no trace context, so none of these controls have alerting.

I would rather state those four myself than have you find them.
