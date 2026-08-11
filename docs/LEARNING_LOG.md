# Learning Log

One entry per AI-engineering concept this system uses. Each entry teaches the concept, states the
real trade-off, ties the choice to this system's constraint, walks the actual code, and ends with an
answer I can say out loud. Implementation depth lives in the linked ADR, not here.

---

## 001 — Hybrid retrieval, and why rank fusion fuses ranks instead of scores

**ADR:** [0002](./adr/0002-single-store-hybrid-retrieval.md) · **Code:**
`src/providers/retrieval/mongo-hybrid.store.ts`

**The concept.** Retrieval means: given a question, return the passages most likely to contain the
answer. Two families of scorer do this, and they compute completely different things.

BM25 is lexical. It scores a passage on the query terms it literally contains, weighting each term
by how rare it is corpus-wide (IDF), saturating repeated occurrences so a term appearing twenty
times is not twenty times better than once, and normalizing by passage length so long documents do
not win by volume. It works over an inverted index, and it only ever matches tokens.

A dense embedding is the other family. An encoder model maps a passage to a fixed-length vector —
here, a Voyage embedding — positioned so that passages meaning similar things land near each other
geometrically. Similarity is cosine distance between two such vectors, so a query and a passage can
match with zero words in common.

| | BM25 (lexical) | Dense (vector) |
| --- | --- | --- |
| Wins on | rare literal tokens: `5.25%`, a proper noun, a clause number | paraphrase — "how aggressive was the pricing" against a paragraph that never says "aggressive" |
| Fails on | a question sharing no vocabulary with its answer | ranking a semantically adjacent passage above the one holding the exact figure |
| Score range | unbounded, corpus-dependent | bounded, tightly clustered |

Reciprocal rank fusion combines them without adding their scores: `score(d) = Σ_p w_p / (k + rank_p(d))`.
It throws the scores away and keeps only each pipeline's *ordering*, which makes the result invariant
to any monotonic rescaling of either signal. `k = 60` flattens the head of each list, so agreement
across both pipelines outweighs depth in one.

**The trade-off.** The alternative is per-query score normalization — min-max or z-score each
pipeline's scores into a common range, then add. That preserves margin information RRF discards (the
gap between hit #1 and hit #2 is real signal), at the cost of stability: over a small clustered
candidate set it amplifies noise into a confident-looking ranking, and it needs recalibration whenever
either scorer changes.

**What we chose, and why here.** Single-store hybrid on MongoDB with server-side `$rankFusion`,
`k = 60`, equal weights. The deciding constraint was provenance, not ranking quality: every chunk
carries a document version, content hash and locator, and a separate vector store forces either
duplicated provenance or a second round trip on every hit. Tenant scoping runs *inside* both input
pipelines — post-filtering ranks a candidate set you then discard, which changes the final top-k.

**In our code.** `src/providers/retrieval/mongo-hybrid.store.ts` — `search()` embeds the query, then
routes to `searchServerSide()` or `searchAppSide()`. `searchServerSide()` builds one `$rankFusion`
stage with two named input pipelines, `search` and `vector`, explicit
`combination: { weights: PIPELINE_WEIGHTS }`, and `scoreDetails: true` so each hit carries a
per-pipeline rank/weight/value breakdown; `searchAppSide()` reimplements the identical formula in
TypeScript against `RRF_K = 60`, so the two modes stay comparable.

`extractTenantId()` throws on a missing tenant rather than defaulting — fails closed, since the filter
lives inside the pipelines and its absence would silently query every tenant. `embedQuery()` passes
`inputType: 'query'`; `ingestion.service.ts` passes `'document'`.

**How we validated it.** ADR-0002's go/no-go probe was built to reject *both* wrong answers: a false
no-go (`$rankFusion` errors against a collection with no search indexes, even on a server that
supports it) and a false go (a `$rankFusion` whose inputs are only `$search`/`$match` succeeds on
older servers). It came back GO on server 8.3.4, and the server's own score description string read
`sum(weight * (1 / (60 + rank)))` — where `RRF_K` comes from.
`test/providers/retrieval/mongo-hybrid.store.integration-spec.ts` then runs both fusion modes live,
asserting a seeded chunk returns with a non-null per-pipeline rank and that the same query under a
different `tenantId` returns nothing.

**Interview answer.** Lexical and dense retrieval fail in opposite directions, so I run both and fuse
them by rank, not by score — BM25 is unbounded and corpus-dependent while cosine is bounded and
clustered, so adding them silently elects one pipeline and the winner changes on an index rebuild.
RRF keeps only the ordering, which survives any rescaling of either signal, and `k = 60` makes
cross-pipeline agreement count for more than depth in one list. I kept both pipelines in one MongoDB
store because provenance is the hard requirement: a split vector store means either duplicated
document-version and hash metadata or a second round trip per hit. And I filter by tenant inside each
input pipeline rather than after fusion — filtering afterwards changes which documents make the final
top-k, so it is a correctness bug dressed as an optimization.

**Known limit.** The embedding model is asymmetric — passing the document-side input type when
embedding a query returns a perfectly well-formed vector that simply retrieves worse.

---

## 002 — Retrieved text is attacker-controlled: the prompt as a trust boundary

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/evidence/ingestion/sanitize-evidence-text.ts`,
`src/features/evidence/qa/prompts/assemble-answer-messages.ts`

**The concept.** A prompt is one flat token sequence. There is no type system inside it, no
out-of-band channel, nothing that marks one span "instructions" and another "data to reason about" —
the model infers that distinction from the text itself, which means the text can lie about it.

Retrieved document text is input from an untrusted party. Whoever authored the PDF chose every byte,
including bytes intended for a model that will later be shown them. That makes RAG's retrieval step
an injection surface in exactly the way a SQL query built by string concatenation is.

The boundary has two halves. **Placement:** evidence never enters the system prompt, only a fenced
block inside a user turn, so an injected instruction *competes with* the system prompt instead of
*being* it. **Fence integrity:** the delimiter must be escaped in the content, or the content closes
its own fence and everything after it reads as top-level instruction.

**The trade-off.** The question is *where* to escape. Prompt-assembly time is the obvious answer and
keeps stored evidence byte-faithful — but the grounding gate (entry 004) compares the model's quote
against the stored bytes, and that comparison only holds if the stored chunk *is* the prompted chunk.
Escape at assembly and the model quotes escaped text while the gate checks raw text, so every
citation over affected content fails verification for the wrong reason.

**What we chose, and why here.** Escape once, at ingestion. The cost is byte-faithful storage, paid
only by documents that literally contain the delimiter — for everything else the escaper is the
identity function.

**In our code.** `sanitize-evidence-text.ts` — `sanitizeEvidenceText()` rewrites the delimiter pattern
to `&lt;…`, case-insensitively, because a model reads `</EVIDENCE>` as a closing tag just as well as
the lowercase form. The tag is exported as `EVIDENCE_DELIMITER_TAG` so sanitizer and prompt builder
cannot drift apart.

`assemble-answer-messages.ts` — `buildSystemPrompt()` carries instructions only.
`formatEvidenceBlock()` emits a bare `<evidence>` tag, then `chunkId:` and `locator:` on their own
lines, then the text; `formatLabel()` sanitizes those two header fields and collapses embedded
newlines to one space.

The bug worth carrying: chunk id and locator used to be XML attributes, and the escaper handled `<`
but not the `"` that terminates an attribute value — so a crafted DOCX heading could close the
attribute and write text the model read as outside the fence. The fix was deleting the attribute
position, not escaping harder; then collapsing newlines, because a bare-line format introduces a
newline delimiter the old one did not have. Enumerate the delimiters your *new* format has.

**How we validated it.** `test/features/evidence/qa/prompts/assemble-answer-messages.spec.ts` asserts
chunk text never reaches the system prompt, that a quote/attribute-breakout payload in a DOCX heading
stays confined to its locator line, and that a sheet name cannot forge a second `chunkId:` header.
`test/security/canary.spec.ts` plants marker tokens in the fixture corpus and asserts they appear
strictly inside their own fence.

**Interview answer.** Retrieved document text is attacker-controlled — whoever wrote the PDF chose
every byte, and the model can't tell "text to reason about" from "text telling me what to do" because
both arrive as tokens in one window. So evidence never enters the system prompt, only a fenced block
in a user turn, and the delimiter is escaped in the stored text so content can't close its own fence.
I escape at ingestion rather than at assembly because my grounding gate compares the model's quote
against the stored bytes, and escaping later would break that alignment and fail honest citations. We
had a real breakout: the id and locator were XML attributes and the escaper missed the quote
character, so the fix was removing the attribute position entirely rather than escaping harder. It's
one layer, not the defense — it sits beside the citation verifier, the tool allowlist, and canary
fixtures.

**Known limit.** The canary suite also documents the honest bound: a token a non-compliant model
echoes straight into its answer passes through unfiltered. Fencing constrains what the model is
told, not what it says.

---

## 003 — Structured outputs: constraining generation instead of parsing prose

**ADR:** [0006](./adr/0006-model-access-behind-a-decorated-provider.md) · **Code:**
`src/features/evidence/qa/contracts/answer.contract.ts`, `src/providers/model/`

**The concept.** A language model emits tokens, not objects. Getting a machine-readable value out of
one means deciding where the guarantee that it *is* that shape actually lives.

| Approach | Where the guarantee lives | What it's worth |
| --- | --- | --- |
| Ask for JSON in the prompt, parse the reply | nowhere | a behavioural tendency that degrades under long contexts |
| Force a tool call whose input schema is your shape | the tool-use machinery | genuinely constrained, but a shape mismatch — you describe a function invocation to obtain a value |
| Native structured output against a schema | the vendor's decoding path | the API rejects or constrains non-conforming output |

Native structured outputs work by constraining generation against the schema rather than hoping for
it: the sampler's token distribution is restricted to tokens that keep the output a valid prefix of
some schema instance. Malformed JSON stops being unlikely and becomes hard to reach.

**The trade-off.** All of it buys *syntactic* validity and nothing else. A schema-valid answer can be
entirely fabricated — which is why entry 004 exists.

The subtler cost is that a rigid schema forces the model into a shape it did not conclude. The
mitigation is design, not library. If the schema has only an `answered` branch, abstention is
grammatically illegal and confident fabrication becomes the only legal output: the schema you added
for safety causes the hallucination.

**What we chose, and why here.** Native structured output, because the answer genuinely *is* a JSON
object and the same schema is what the planned eval harness will score against. It is a discriminated union with
three branches — `answered`, `insufficient_evidence`, `conflicting_evidence` — so abstention and "the
sources disagree" are both legal, first-class outputs. And a vendor guarantee is a claim to check,
not an axiom: we constrain at the API *and* re-validate app-side.

**In our code.** `answer.contract.ts` — `answerContractSchema` is that union, and it is the *only*
schema the model ever sees. `answerEnvelopeSchema` adds `claimCoverage` and `verificationReport` on
top, so those fields are structurally absent from the model's grammar: forging them is impossible
rather than merely detected, and the server computes them after the call. That is the idea worth
stealing — the schema is a capability boundary.

`anthropic-model.provider.ts` — `generate()` passes
`output_config: { format: zodOutputFormat(schema) }`, then still runs `JSON.parse` plus
`schema.safeParse` in `safeParseJson()`. On a validation failure it retries exactly once with the
formatted issues fed back, bills and accumulates both calls, and throws `ModelSchemaValidationError`
if the retry also fails. That retry path is not dead code — it is the app-side half of the guarantee.

**How we validated it.** `test/providers/model/anthropic-model.provider.spec.ts` covers the
single-call success, retry-then-succeed, and throw-on-second-failure paths, plus the fail-closed
budget refusal in `assertBudget()`. `answer.contract.spec.ts` carries a compile-time assignability
check keeping the contract's locator union structurally in sync with the database `EvidenceLocator`
type it deliberately does not import.

**Interview answer.** I use native structured outputs so the shape is constrained during generation
rather than parsed out of prose afterwards, but I still re-validate with the same zod schema in my
provider — a vendor guarantee is a claim I check, and there's exactly one retry feeding the validation
errors back before it throws. The design decision that mattered wasn't the mechanism, it was the
schema: a discriminated union including `insufficient_evidence` and `conflicting_evidence`, because
with only an `answered` branch abstention is grammatically illegal and confident fabrication becomes
the only legal output. I also treat the schema as a capability boundary — claim coverage and the
verification report exist only in the server-side envelope, so the model has no grammar for them at
all. And all of this buys syntactic validity only; a schema-valid answer can still be entirely made
up, which is what the grounding gate is for.

---

## 004 — Grounding: verifying a citation is not verifying an answer

**ADR:** [0004](./adr/0004-grounding-gate-and-citation-contract.md) · **Code:**
`src/features/evidence/qa/grounding-gate.service.ts`, `verify-claim.ts`, `locate-quote.ts`

**The concept.** A model *claiming* a citation and a system *verifying* one are different events, and
nearly all the trust rests on the second. A fabricated citation is indistinguishable from a real one
by inspection — it has a plausible id, a plausible page, a fluent quote.

Grounding is the deterministic pass that checks each claimed citation against what was actually
retrieved. It has exactly one power: to drop. It calls no model and never adds a claim, a citation or
a fact. A component that can only subtract cannot hallucinate, which is precisely why it is allowed
to stand between a model and a user.

Three checks per citation, in order: **retrieval containment** — the cited chunk must be among those
retrieved *for this request*, with matching document version and content hash; **quote containment** —
the quote must appear verbatim in that chunk's text under normalization; **numeric support** — every
number in the claim must be present in a cited chunk or backed by an extracted cell fact.

**The trade-off.** The alternative is entailment checking — does this claim actually *follow* from its
evidence? — which needs an LLM-as-judge. It covers the failure this cannot (correctly cited, wrongly
reasoned) at the cost of determinism, safety (the judge is injectable by the very evidence it judges),
and explainability.

**What we chose, and why here.** The deterministic citation check, fail-closed at claim granularity.
One failing citation drops the *whole* claim, so padding a fabricated citation onto a good one earns
no partial credit. Similarity is never an acceptance bar — credit for a citation that merely sounds
right is the failure mode itself.

**In our code.** `grounding-gate.service.ts` — `GroundingGateService.verify()` runs `verifyClaim()`
per claim, then applies outcome-level degradation: all survive → `answered` at full coverage; some
survive → `answered` at reduced coverage with drops recorded; none survive → `insufficient_evidence`,
so the system can abstain even when the model did not.

`verify-claim.ts` — `verifyClaim()` implements checks 1a (chunk not retrieved), 1b (version/hash
mismatch), 2 (quote), 3 (numeric), each emitting a typed `GroundingViolation`.

`locate-quote.ts` — `locateQuote()` passes only on normalized containment (`kind: 'exact'`). It also
computes a bounded approximate substring edit distance (`bestSubstringEditDistance`, the standard
Sellers/Ukkonen recurrence with a free start and end in the text) — but purely to label a rejection
`'fuzzy'` rather than `'none'`. `FUZZY_SIMILARITY_THRESHOLD` can change how a quote fails; no value of
it lets one pass.

**How we validated it.** `verify-claim.spec.ts` and `locate-quote.spec.ts` drive each violation kind
and each degradation path; `grounding-gate.service.spec.ts` holds the service to 100% branch coverage.
`test/security/canary.spec.ts` asserts the *bound*: a claim citing an injected sentence verbatim
survives citation verification, because the sentence really is in the chunk.

**Interview answer.** The gate verifies citations, not reasoning, and I'm deliberate about the
distinction. Per citation it checks that the chunk was actually retrieved for this request with a
matching document version and content hash, that the quote appears verbatim under normalization, and
that every number in the claim is supported — failing closed at claim granularity, so one bad citation
drops the whole claim and a model can't pad a fabrication onto a good one for partial credit. If every
claim fails, the gate returns `insufficient_evidence` itself, so the system abstains even when the
model wouldn't. The reason I'm willing to put it between a model and a user is that its only power is
to drop — it calls no model and never adds a claim, so it can't hallucinate. And I know its bound: an
injected sentence genuinely present in the source is truthfully cited and passes, which is why this is
one layer beside prompt fencing and canary tests.

**Known limits.** Numeric support is digit-pattern matching in `extract-numeric-tokens.ts`, so a
figure written in words ("six percent") is invisible to it. Per-claim verification only ever has
claims to check on the `answered` branch — an abstention carries no citations to verify. That no
longer means an abstention is a simple pass-through, though, and the asymmetry is worth knowing.
The `answered` branch's own conflict-forcing (ADR-0004 bounds 3, 6, 9) is checked independently of
anything the model said: any surviving claim stating a number that matches a known conflict, cited
from the chunk it names, forces `conflicting_evidence` whether or not the model noticed.
`groundingCheck` (`src/worker/activities.ts`) can also upgrade an `insufficient_evidence`
abstention to `conflicting_evidence` (ADR-0004 bound 9) — but only when the model's own
`reasonCode` names the contradiction itself ("model hints, server verifies"). An abstention for any
other reason, even against a corpus that holds a real, seeded conflict the model simply didn't
flag, is returned unchanged, because nothing else scans an abstention for a conflict it never
claimed to have found.

---

## 005 — Deterministic authorization: the model proposes, the application disposes

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/platform/authz/`

**The concept.** Entry 004 applies "the model proposes, the application disposes" to *assertions*.
Applied to *actions* it is strictly harsher, because an action has side effects: you cannot drop a
tool call after it has already sent the email.

A restriction expressed in a prompt — "only use the read-only tools" — is text, sitting in the same
context window as attacker-controlled document text, subject to the same instruction-following
pressure. It is a preference, not a control. So whether a tool call is permitted has to be answered
by deterministic code the model has no path into.

**The trade-off.** A remote policy service (OPA, an authz microservice) centralizes policy and lets it
change without a deploy, at the cost of a network hop inside every tool call, a time-of-check window,
and a decision you cannot replay offline. A synchronous local hook is the reverse: policy must be
materialized into the process, but the decision is fast, replayable, and has no check-to-use window.

**What we chose, and why here.** A synchronous hook, injected once through DI. Injected *once*
matters: a per-call hook parameter is itself a bypass vector, because the one caller who passes a
permissive stub reopens the gate invisibly.

**In our code.** `tool-executor.service.ts` — `ToolExecutorService.execute()` is the single
chokepoint, with four gates whose *order* is the design: registry membership → the step's allowlist →
the authz hook → strict argument validation. Access is decided on tool identity and step context
alone, before the still-attacker-controlled arguments are parsed — parsing is work on untrusted input,
and none of it should happen before the call is known to be permitted, so a refusal also leaks nothing
about the argument surface.

Three details carry weight. A hook that *throws* is a refusal (`authz-hook-error`), because permission
gates fail closed and a broken check is not an open one. The decision must be the literal `true` —
`{ allowed: 'yes' }` is truthy and `if (decision.allowed)` would let it through. And zod's `.strict()`
applies one level deep only, so `registerTool()` runs `applyStrictRecursively()` at registration
rather than trusting each tool author to remember it at every nesting level. `DenyAllAuthzHook` is the
default binding.

**How we validated it.** `test/features/platform/authz/tool-executor.service.spec.ts` holds the
service to 100% branch coverage, including the throwing hook and the truthy-but-not-`true` decision.
`test/security/canary.spec.ts` exercises it against the real (currently empty) registry and the real
`DenyAllAuthzHook.authorize()` once a tool is registered and allowlisted — refusal from the production
objects, not a mock.

**Interview answer.** Anything a model influences I treat as a proposal, so whether a tool call is
permitted is decided by deterministic code the model has no path into — a restriction written into a
prompt is just text competing with attacker-controlled text in the same window. There's one chokepoint
with four gates in a deliberate order: registry membership, the step's allowlist, a synchronous authz
hook, then strict argument validation, so access is decided on tool identity and step context before
anything parses the untrusted payload. It fails closed everywhere: a hook that throws is a refusal,
and the decision has to be the literal `true`, because `{allowed: 'yes'}` is truthy and would sail
past a naive check. The hook is injected once through DI rather than passed per call, since a per-call
hook is itself the bypass.

**Known limit.** Nothing calls the chokepoint yet — it exists so that when a caller is wired, refusal
is the default it inherits rather than a control someone has to remember to add.

---

## 006 — The determinism boundary in durable execution

**ADR:** [0003](./adr/0003-temporal-from-day-one.md) · **Code:** `src/workflows/`, `src/worker/`

**The concept.** A durable execution engine does not persist your variables. It persists an *event
history* — every command the workflow issued and every result it received — and rebuilds live state
by re-executing the workflow function from the top with those recorded results fed back in place of
the calls that produced them.

That imposes exactly one demand: workflow code must be a pure function of its history. Same history →
same commands → same order. Read the clock, take a random number, or make a network call directly in
workflow code and the replay diverges from the history; the engine detects that and fails the task.

The consequence for AI work is direct. A model call is non-deterministic even at temperature zero
once model versions move, so it cannot live in workflow code. It lives in an *activity*, and what
the history records is its *result* — so a workflow killed after an expensive synthesis call resumes
with the recorded answer instead of paying for it twice.

**The trade-off.**

| Option | Durable? | What you hand-write |
| --- | --- | --- |
| In-process `async/await` | no — a restart mid-answer loses the work with no record of how far it got | nothing |
| Queue + state machine | yes, on infrastructure you already run | durable state, retry policy, resumption, indefinite waits — the parts that are subtly wrong in ways tests don't show |
| Durable execution engine | yes | the determinism discipline, plus an engine to operate |

**What we chose, and why here.** Temporal. The requirement that settled it was a human approval gate
lasting hours or days: a polling loop over a status column in the queue design, a signal wait in this
one. Because activity execution is at-least-once, retry policy is set per activity from cost and
idempotency.

**In our code.** `src/workflows/answer-question.workflow.ts` — `answerQuestion()` sequences retrieve →
synthesize → verify grounding → persist and does nothing else; every side effect is an activity. It
declares four separate `proxyActivities` groups so retry policy is per cost class: retrieval (a Mongo
read plus one embedding call) gets `maximumAttempts: 5`, the paid synthesis call gets `2` with a
timeout sized for real model latency, grounding — pure and local — gets `5` and the shortest timeout.

`src/worker/activities.ts` — `createActivities()` returns thin closures over services resolved from
the worker's own Nest DI context, and the workflow file imports this module `import type` only. That
type-only import is the erasure boundary: a value import would pull `@nestjs/common` and, transitively,
mongoose into the workflow bundle. `src/worker/main.ts` sets
`workflowsPath: require.resolve('../workflows')`, and the webpack-based `bundleWorkflowCode` inside
`Worker.create` is the authoritative half of the fence.

**How we validated it.** Two layers, tested separately. `test/eslint/determinism-fence.spec.ts` proves
the `no-restricted-imports` rule over `src/workflows/**` actually rejects a forbidden import and still
allows `@temporalio/workflow`. `test/worker/determinism-fence.spec.ts` bundles the real workflow tree
cleanly, then shows the bundler rejecting a forbidden import while an allowed one bundles from the
same scratch directory.

**Interview answer.** A durable engine replays my workflow function against a recorded event history,
so workflow code has to be a pure function of that history — same history, same commands, same order.
Anything non-deterministic goes in an activity: the model call, the Mongo reads and writes, the
parsing. The payoff is that the history records the *result* of the expensive call, so a worker crash
resumes with the recorded answer instead of paying for it twice. I chose a durable engine over a queue
and a hand-rolled state machine because we need a human approval gate that can wait days — a signal
wait in one design, a polling loop over a status column in the other. And since activity execution is
at-least-once, retry policy is per activity by cost: cheap idempotent reads get generous attempts, the
paid synthesis call gets a low cap.

**Known limit.** The lint rule is a fast signal, not the guarantee — it cannot see a Node builtin
reached transitively through a dependency. The bundler's whole-tree analysis is the real gate.

---

## 007 — Provenance: content addressing, locators, and versioning the coordinate system

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:**
`src/features/evidence/ingestion/parsers/`, `src/features/evidence/qa/evidence-retrieval.service.ts`

**The concept.** A citation is a claim about *where*, and it is worth exactly its ability to keep
resolving — after a re-ingest, a chunking change, a parser upgrade. Three independent pieces make
that hold.

**A content hash** answers "are these the same bytes?" — content addressing, so a document version is
identified by what it contains rather than by a mutable id. **A structured locator** answers "where
inside them?" — a page, a paragraph index plus heading path, a spreadsheet cell — rather than a
character offset that any reflow invalidates. **An extractor version** answers "in whose coordinate
system?"

The third is the one people skip, and it is the one that fails silently. Without it, a parser upgrade
that shifts paragraph numbering raises no error: the citation resolves quietly to the wrong span, and
the answer above it still looks cited.

**The trade-off.** Parse coarsely (page-level, sheet-level) and ingestion is simpler with a small
element count — but a locator you never captured cannot be recovered, and re-ingesting to get it back
invalidates every stored citation. Parse at the finest addressable unit and you pay in element count,
especially for spreadsheets, but granularity can always be coarsened later.

**What we chose, and why here.** Parse at the finest addressable unit, then group upward. Stamp the
extractor version on the *locator*, not the chunk, because the locator is what travels with a
citation.

**In our code.** `pdf.parser.ts` and `docx.parser.ts` each declare their own `EXTRACTOR_VERSION`
(`'pdf-pdfjs-1'`, `'docx-ooxml-1'`) and stamp it onto every locator they emit. `docx.parser.ts` reads
`word/document.xml` directly to produce a `paragraphIndex` and `headingPath` per paragraph;
`xlsx.parser.ts` emits one element per cell.

`chunker.ts` — `chunkElements()` does the grouping upward: `chunkProse()` splits at every heading-path
change *before* any token windowing, and `chunkSheet()` rolls per-cell elements into `xlsx-region`
windows. `anchorLocator()` carries the honest-locator rule — a multi-element chunk anchors to its
first element, and a PDF page's `boundingBox` is dropped once the chunk runs past that page, since
keeping it would assert a location the chunk does not cover.

`evidence-retrieval.service.ts` — `retrieve()` is the single place joining a retrieval hit back to its
`DocumentVersion.sha256`, because the hash lives on the version, not the chunk. That join is what makes
the grounding gate's chunk/version/hash triple check meaningful rather than circular.

The well-regarded DOCX library was rejected on the same logic: it extracts text beautifully and exposes
no stable paragraph index — and a paragraph index is what the locator *is*. Evaluate a library against
the contract, not the category.

**How we validated it.** The parser specs assert per-element locators against known fixtures;
`test/fixtures/manifest.spec.ts` asserts the recorded sha256 matches every committed binary and that
every docx paragraph matches the authored spec order; `eval/resolve-locator.ts` resolves a locator by
re-parsing the source document with the same parser classes ingestion uses.

**Interview answer.** A citation is worth exactly what it can still resolve to after a re-ingest, so I
keep three independent things: a content hash for "are these the same bytes", a structured locator for
"where inside them", and an extractor version for "in whose coordinate system". The third is the one
teams skip and the one that fails silently — a parser upgrade that shifts offsets raises no error, it
resolves quietly to the wrong span while the answer above it still looks cited. I stamp the version on
the locator rather than the chunk, because the locator is what travels with the citation. And I parse
at the finest addressable unit and group upward in the chunker: granularity you captured can always be
coarsened, but one you never captured is gone.

**Known limit.** The PDF bounding box is the union of every text item on the page, so page-level
citation — not UI highlighting — is the real contract today.

---

## 008 — Ground truth is code, and an eval you never watched fail is not an eval

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:** `eval/`,
`fixtures/`

**The concept.** An evaluation dataset is a set of questions with the answers and source locations
you expect — the thing every metric is computed against. It is also a program artifact with its own
correctness problem, and the one artifact nothing downstream can check.

That asymmetry is the whole point. If the ground truth is wrong, a correct system scores badly and an
incorrect one may score well, and no signal anywhere tells you which world you are in. Retrieval
precision, citation accuracy, abstention rate — all of them are *conditional* on a dataset nobody
graded.

So the dataset is code: schema-validated, and tested against the artifacts it describes.

**The trade-off.** Hand-authored ground truth under human review is what most teams do, and it is
better at capturing intent — a human writes the question they actually care about. It trades this bug
class for an unfalsifiable one: no test can tell you a hand-written expectation is wrong. Generated
fixtures are checkable, at the cost of being synthetic and only as interesting as the generator.

**What we chose, and why here.** Generated fixtures, generated dataset, both checked against the
documents themselves — because "checkable" is exactly what the failure below cost us.

**The failure that taught it.** The fixture generator wrote each page's footer below the margin, the
PDF library treated that as overflow and started a new page, and the memo ended up with eight physical
pages while the manifest recorded four. Every PDF citation in the ground truth pointed at a blank page,
and nothing failed — the manifest was self-consistent and the dataset validated against the manifest.
Two derived artifacts agreeing with each other is not evidence about the thing they came from.

**In our code.** `eval/dataset/schema.ts` — `EvalCaseSchema` / `EvalDatasetSchema` make the dataset
parseable rather than merely readable. `eval/resolve-locator.ts` — `resolveLocatorElements()` and
`resolveLocatorText()` resolve a case's locator by parsing the actual fixture with `PdfParser`,
`DocxParser`, `XlsxParser`, the same classes ingestion uses.

`test/fixtures/dataset.spec.ts` runs both layers deliberately.
`assertLocatorExistsInManifest()` is the cheap check — the dataset agrees with the generator. The
second `describe` block is the one that would have caught the bug: for every answerable and
conflicting case it resolves the locator against the parsed document, fails distinctly when it
resolves to nothing at all, and asserts each `expectedAnswerContains` substring is really there.

**How we validated it.** By making the checks fail first. Each new assertion here was mutated until it
went red before it was trusted — the same discipline as the go/no-go probe in entry 001, built to
reject both a false go and a false no-go, and the fence tests in entry 002.

**Interview answer.** I treat the eval dataset as code, because every metric is conditional on it and
nothing downstream can check it — if the ground truth is wrong, a correct system scores badly and no
signal tells you which world you're in. We learned that concretely: our fixture generator emitted a
stray blank page after every content page, so a memo had eight physical pages while the manifest
recorded four, and every PDF citation in the dataset pointed at blank paper with every test still
green. Two derived artifacts agreeing with each other isn't evidence about the document they came
from, so locators are now resolved against the real document using the same parsers ingestion uses.
And I don't trust an assertion that passed on its first run — it hasn't distinguished "the property
holds" from "this assertion cannot fail", so I make each one go red before I believe it.

---

## 009 — Self-consistency across independent passes: what agreement buys, and what it can't

**ADR:** [0007](./adr/0007-eval-replay-cache.md) · **Code:**
`src/features/evidence/facts/agree-facts.ts`, `prose-fact-extractor.ts`,
`src/providers/model/cache-key.util.ts`

**The concept.** A single model call at temperature zero is not a deterministic function of its
prompt — sampling, batching, and vendor-side routing all leave room for the same input to produce a
different output on two calls. Self-consistency treats that as measurable rather than assumed away:
run the same prompt N times independently, and keep only the answer(s) a majority of passes agree
on. What that recovers is *stability* — the same input reliably yields the same accepted output, run
to run — not *correctness*. Agreement across samples is evidence the model is confident and
consistent, not evidence it is right; three passes converging on a wrong answer is still wrong, just
now repeatably wrong.

**The trade-off.** More passes buy more confidence in the majority at linearly increasing cost — N
calls instead of one, run concurrently if latency matters, still N times the spend. The payoff
saturates fast: for a 2-of-N-agree rule, N=3 is already a majority rather than a tie, so N=5 mostly
adds cost, not signal, unless the underlying variance is high enough that 2-of-3 is itself
unreliable. The sharper limit isn't cost, though — it's scope. Self-consistency can only recover a
fact that at least two passes were *capable* of producing in the first place. If a downstream,
deterministic filter rejects a fact on every pass for the same structural reason — not sampling
noise — N passes reject it N times, and agreement has nothing to vote on. Variance reduction cannot
fix a bug.

**What we chose, and why here.** Three independent extraction passes over identical chunk text,
keeping any `(entity, metric, period)` group at least two passes agree on within the metric's own
tolerance — because a single pass measurably returned 8, 2, and 0 facts for byte-identical real
document text across live runs, and a deterministic downstream conflict scan cannot be fed input
that unstable.

**In our code.** `prose-fact-extractor.ts` fires `PASS_COUNT = 3` calls via `Promise.allSettled`, so
a thrown pass (the SDK's own retries already exhausted) is a *non-vote*, never miscounted as a vote
for zero facts. `agree-facts.ts`'s `agreeFacts()` groups candidates by fact key and tries every vote
as its own pivot (`largestAgreeingCluster`) rather than a single min/max spread check, because a
spread check drops a real 2-of-3 majority whenever the third pass lands far enough outside tolerance
— exactly the case the majority rule exists to recover.

The detail worth stealing on its own: `ModelRequest.passOrdinal` is folded into `computeCacheKey`
but never forwarded to the vendor SDK — a cache-partitioning field, invisible to the model. Without
it, three identical prompts hash to one cache key, and the caching provider's read-through record
mode would silently replay pass 1's response for passes 2 and 3, making agreement vacuous in every
recorded/replayed eval run while the live path genuinely varied call to call. Varying the *prompt*
per pass instead (a "this is attempt 2" preamble) would have solved the cache-collision problem too,
at the cost of changing what the model actually sees and sends to the vendor — a key-only field
partitions the cache without touching the request the model reasons over.

**How we validated it.** `test/features/evidence/facts/agree-facts.spec.ts` drives the pivot-search
majority logic directly, including the case a naive spread check gets wrong. A live re-record and
replay against the real model measured the intended effect (stable fact counts across identical
input) directly, rather than trusting the design.

**Interview answer.** Self-consistency is a variance-reduction technique, not a correctness
technique — running N passes and keeping majority agreement makes "what the model reliably produces
for this input" repeatable, it doesn't make that output right. I use it where I measured real
sample-to-sample variance (8, 2, 0 facts for identical input), and I fold the pass number into the
*cache key only*, never into the prompt, so record/replay stays honest about whether three genuinely
independent samples were taken. And I know its ceiling: it can only recover a fact the model was
*capable* of producing on some pass. If a downstream deterministic check rejects a fact for a
structural reason — not noise — agreement has nothing left to vote on, and no amount of resampling
fixes that.

**Known limit.** A pass that throws is a non-vote, correctly — but that also means a systematically
flaky provider (rate limits, timeouts) can silently degrade N real independent passes down to one or
two without ever surfacing as a wrong answer, only as a quieter warning.

---

## 010 — When two verifiers check the same invariant at different strictness, the stricter one fails silently

**ADR:** [0004](./adr/0004-grounding-gate-and-citation-contract.md) · **Code:**
`src/shared/utils/locate-quote.util.ts`, `src/features/evidence/facts/prose-fact-extractor.ts`

**The concept.** A pipeline that checks the same kind of thing twice — "is this quote really in the
source" — can quietly implement that check two different ways in two different places, once someone
reaches for the nearest string method instead of the module that already owns the check. Both pass
the tests written against them, because both are internally consistent; they just don't agree with
*each other* on borderline input. The failure that surfaces is not "the verifier is wrong" in any
obvious sense — it's a class of otherwise-valid input the stricter check rejects and the looser one
wouldn't have, and it reads exactly like model unreliability: the same fact, the same document,
extracted sometimes and not others, for no reason anyone can see by staring at the prompt.

**The trade-off.** Sharing one verifier everywhere is the obvious fix once you see the drift, but it
isn't free: a verifier tuned exactly right for one call site (an answer's citation, checked against a
whole retrieved chunk) may be laxer or stricter than a second call site actually wants (a candidate
fact, checked mid-extraction against the same chunk) — reusing it means either call site inherits
tolerances it did not independently choose. The alternative, two independently-tuned checks,
guarantees the drift comes back the moment either one changes without the other noticing.

**What we chose, and why here.** Share the verifier. `verifyClaim` (answer citations) already used
`locateQuote` — whitespace-run and unicode quote/dash-variant normalized containment, deliberately
still rejecting anything that isn't a genuine verbatim match. `prose-fact-extractor.ts`'s two quote
checks used raw `.includes()` instead, and a PDF chunk preserves the source's hard line wraps while a
model always renders a wrapped line as a space when it quotes it back — so any fact whose source
sentence happened to wrap mid-line failed the raw check on *every* extraction pass, deterministically.
It looked like the model "couldn't find" a specific figure; the model had extracted it correctly
every time, and a stricter, independently-written check downstream discarded it every time.

**In our code.** `prose-fact-extractor.ts`'s `evaluateCandidates()` (accepting a candidate) and
`resolveFactLocator()` (recovering which parsed element a fact came from) both now call the same
`locateQuote()` `verifyClaim` uses, requiring `kind === 'exact'` — not a weaker bar than the raw
check, since it relaxes whitespace-run and unicode-variant strictness only; a paraphrased or
fabricated quote still normalizes to a different string and still fails closed.

**How we validated it.** The eval harness's own `conflictRecall` metric was the forcing function: a
seeded conflict whose PDF-side value happened to wrap across a line was structurally unstorable
before the fix, extraction-pass count notwithstanding, and reachable after it — measured, not
inferred, across a real record/replay pair.

**Interview answer.** Two components checking the same invariant at different strictness is a bug
that presents as model unreliability, not as a verifier bug — the symptom is "this figure gets
extracted sometimes," and nothing about that symptom points at a whitespace-normalization mismatch
between two quote checks written at different times. When I see a deterministic pipeline behave
inconsistently on what looks like the same input, I now check for a second implementation of the
same check before I suspect the model — a raw `.includes()` next to a shared, already-normalized
verifier is exactly the shape of bug that a re-prompt or a temperature change can never fix, because
it isn't happening in the model at all.

**Known limit.** Sharing the verifier only closes the drift for the two call sites that now use it. A
third quote check written independently, elsewhere, would silently reopen exactly the same class of
bug — normalization discipline has to be a convention (use `locateQuote`, don't write a new
containment check), not a property of any one shared function.
