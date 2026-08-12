# Technical walkthrough — five minutes

A script to say aloud. The answer-quality numbers come from
`eval/results/467691d0e69f6445c4f2cca27b6e6dba636bad50.md`, the newest recording made against a clean
tree; the retrieval-mode comparison including the `qdrant-vector` row is in
[`docs/adr/0010-retrieval-store-comparison.md`](adr/0010-retrieval-store-comparison.md). Both are
tracked. A run against a dirty tree writes a `-dirty`-suffixed file, which `.gitignore` excludes
precisely because the suffix marks provenance as untrustworthy — so nothing here should ever cite
one, and an earlier draft of this document citing a since-deleted `-dirty` file is why that rule
exists.

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

## 0:45–1:45 — Four design decisions, quickly

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

Fourth, human approval is a durable Temporal signal that only ever wakes the workflow, never decides
for it — the handler flips one boolean, the workflow re-reads the durable approval row for the
verdict, and a timeout writes `timed_out` without falling through to that read, so a spoofed signal
can wake a workflow but never forge a decision. It's reachable end to end in the UI now too: request
resolution from the Conflicts page, approve from the Approvals inbox.

## 1:45–3:25 — What actually went wrong

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

## 3:25–4:20 — What it measures

Thirty-two cases: twelve answerable, eight unanswerable, five conflicting, seven adversarial. Recall
at five is 82.6%, MRR 0.675, citation precision 81.0%, mean claim coverage 93.6%. Abstention accuracy
is 100% — all eight unanswerable questions abstain rather than fabricate. Conflict recall is 100% on
this recording — all five conflict cases pass. The canary own-voice leak rate is a hard gate at zero
and passes. Zero cases fail.

One retrieval-comparison result deserves a beat. Qdrant, run as a fourth mode, came back numerically
identical to Mongo's own vector mode — 82.6% recall at five, 91.3% at ten, 0.648 MRR, to the metric.
But the corpus is twelve chunks, small enough that both engines are doing exhaustive search, so
Qdrant's approximate index never got a chance to approximate — identical here is not equivalent at
scale; it says the embeddings and fusion strategy are the differentiator, not the engine. The same
comparison carries a standing oddity: vector beats hybrid at recall@10 — 91.3% against 82.6% — while
hybrid leads MRR — 0.667 against 0.648 — so which pipeline "wins" depends on which metric you read,
and I won't claim hybrid is an unqualified win.

## 4:20–5:00 — Where it is weak

Conflict recall is 100% on this recording, but that number is not a guarantee: prose fact extraction
varies run to run, and sampling cannot be pinned on this model tier — the API rejects a temperature
parameter outright — so what replay stabilises is the measurement, not the pipeline, and a conflict
can still be found on one recording and missed on the next. Tenant isolation is structural now, not
just threaded through: `tenantId` is a required JWT claim — the guard fails closed if it's missing —
and every evidence service still takes it as an explicit parameter, backstopped by a global Mongoose
plugin that intersects the tenant into every scoped query. A negative control proved the two layers
are genuinely independent: reverting one service's tenant predicate left the isolation suite green,
because the plugin caught it; disabling the plugin too made it fail exactly where I expected, tenant
B reading tenant A's answer. Still missing: role granularity beyond admin and member, per-user
ownership inside a tenant, and any way to provision a second tenant at all. The tool chokepoint has
no caller yet — it exists so that when one is wired, refusal is what it inherits. And tracing is real
OpenTelemetry now — but alerting still does not exist, so none of these controls raise anything when
they fire.

I would rather state those four myself than have you find them.
