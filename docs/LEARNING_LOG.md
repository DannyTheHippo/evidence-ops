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

---

## 011 — Human-in-the-loop as a durability problem, not a UI problem

**ADR:** [0009](./adr/0009-durable-human-approval-gates.md) · **Code:**
`src/workflows/resolve-conflict.workflow.ts`, `src/workflows/ingest-document-version.workflow.ts`,
`src/providers/approval-channel/`

**The concept.** "Wait for a human to decide" looks like a UI problem — show a button, wait for a
click — until you ask what happens to the wait itself while nobody has clicked yet. A human may
take minutes or days, and whatever is holding that wait has to survive everything that happens in
between: a deploy, a crash, a routine process recycle. A wait held in one process's memory — a
promise sitting in a closure, a callback array keyed by request id — dies the moment that process
does, silently, with no record it was ever waiting. That makes human-in-the-loop fundamentally a
durable-state problem: the interesting engineering is in *where the wait lives*, not in what the
approve/reject screen looks like.

Two mechanisms can make a wait durable. A polling loop re-checks some persisted status on a timer
— durable, but it is a hand-rolled state machine (backoff, retry, "how often is often enough")
sitting on top of infrastructure that may already offer one. A durable-execution engine's own
signal-plus-`condition()` primitive persists the wait itself as part of a recorded history, so a
crashed worker resumes the same wait on replay rather than needing to reconstruct one.

**The trade-off.** A signal is not the same kind of channel a request-scoped callback is. A
callback closure can only be invoked by code that holds a reference to it — capability by
construction. A signal is addressed by an id (a workflow id, a channel name) that anything holding
that id can send to, including a caller who guessed, leaked, or replayed one. Durability and
capability-based trust point in different directions: making a wait outlive a process means giving
up the implicit access control a same-process closure gets for free, and that has to be replaced
with something explicit.

**What we chose, and why here.** Replace it with a rule about what the wake-up is allowed to mean:
a signal may only ever *wake* the waiting code, never *tell it the answer*. The verdict comes from
a second, independent read of durable, authoritatively-written state — not from anything the
wake-up carried. An untrusted party can cause the wake-up to fire; they cannot make the subsequent
read say something a real decision-maker didn't write.

**In our code.** Both `resolve-conflict.workflow.ts` and `ingest-document-version.workflow.ts`
register a signal handler that does exactly one thing — flip a local `signaled` flag — and neither
ever reads the signal's own payload (`claimedDecision`) as the outcome. On waking from
`condition(() => signaled, '24 hours')`, each calls `getApprovalDecision(approvalId)`, which
re-reads the `Approval` document `ApprovalsService.decide()` — the one HTTP-authenticated writer —
last wrote. A caller who sends `{ claimedDecision: 'approved' }` to a real `workflowId` still only
wakes the workflow; the row it then reads says whatever `decide()` actually persisted, or still
`pending` if nobody has. `MongoApprovalChannel.getDecision` collapses anything other than exactly
`'approved'` to `rejected` — a second, independent fail-closed check on top of the workflow's own
discipline, not a rephrasing of it. A timeout gets the same treatment from the other direction:
`condition()` returning `false` is its own terminal branch, decided without ever calling
`getApprovalDecision` at all, so "nobody answered in time" can never be blurred into whatever a
stale row happens to say.

**How we validated it.** Both workflow specs drive a payload that *claims* approval
(`claimedDecision: 'approved'`) through the real signal handler while the mocked persisted row says
`rejected`, and assert the outcome is `rejected` — proving the payload was never consulted, not
merely asserting the happy path. A separate case drives the timeout branch and asserts
`getApprovalDecision` was never called at all.

**Interview answer.** I treat "wait for a human" as a durability problem before it's a UI
problem — the wait has to survive a process restart across a window that can be hours or days, so
where it lives matters more than what the approve button looks like. The part that took the most
care wasn't durability itself, though, that's what a workflow engine's signal-plus-`condition()`
buys directly. It was that making the wait durable also means addressing it by an id anything can
message, which forfeits the implicit access control a same-process callback gets for free. The fix
is a rule, not a lock: a signal only ever wakes the code, it never carries the verdict — the
verdict is a second, independent read of state only an authenticated writer could have produced.
That's the transferable idea, and it generalized cleanly to a second, unrelated gated action
without needing a new primitive, which is itself evidence the rule was doing the real work rather
than something specific to the first workflow it was written for.

**Known limit.** The rule closes forgery of the *verdict*; it does not close forgery of the
*request* to gate something in the first place. Anything that can start a gated workflow with a
crafted `subject`/`summary` can still put a plausible-looking entry in front of a human reviewer —
the review step assumes the request reaching it is legitimate, and checking that is a different,
unaddressed boundary.

---

## 012 — Structural enforcement versus discipline, and what a negative control actually proves

**ADR:** [0011](./adr/0011-structural-tenant-isolation-and-minimal-roles.md) · **Code:**
`src/database/plugins/tenant-scope.plugin.ts`

**The concept.** A cross-cutting invariant — "every query for tenant-scoped data is filtered by the
caller's tenant" — can be enforced two structurally different ways, and it's worth being precise
about what each one actually guarantees. **Discipline** means every call site is individually
responsible: each service method takes a `tenantId` parameter and threads it into its own query. It
is precise — a method can reason about exactly the tenant it needs — but its correctness is the
correctness of every call site, forever, including the one written by someone who hasn't read the
convention. **Structural enforcement** means one piece of code, wired in globally, intercepts every
operation of a given shape and applies the invariant without any call site opting in. It cannot be
individually forgotten, because no individual call site is where the decision lives — but it can
only enforce what it can actually see, and "globally wired in" is doing a lot of work in that
sentence: global with respect to *what*, exactly, is the question that decides where the interceptor
has no reach at all.

These fail differently on purpose, not by accident. Discipline fails at the granularity of "one
call site, one bug" — a single forgotten filter is a single leak, findable by reading that one
method. Structural enforcement fails at the granularity of its own blind spots — a case entirely
outside what it intercepts (a raw driver call, an operation type it doesn't hook, a context it
can't observe) isn't a bug in the interceptor, it's a hole in its coverage, and coverage holes look
identical to "everything's fine" until something drives a case through one. Neither failure mode
dominates the other; they are different distributions of the same underlying risk.

**The trade-off.** Combining both looks obviously better and mostly is, but it isn't free: two
mechanisms enforcing the same invariant means two things that have to actually agree with each
other, and disagreement between them is now itself a new failure mode. A structural layer that
*overwrites* what a call site set is the sharpest version of this — it can silently discard a
caller's real, intentional filter, replacing a bug that would have leaked data with a bug that
corrupts an unrelated query. The safer combination doesn't overwrite; it narrows. Intersecting the
structural predicate with whatever the call site already asked for means a call site that got it
right is unaffected, and a call site that forgot gets the structural predicate anyway — disagreement
between the two degrades to "returns less than expected," never "returns something wrong."

**What we chose, and why here.** Keep the discipline (explicit `tenantId` parameters, threaded
through every tenant-scoped service method) as the primary control, and add a structural layer — a
global Mongoose plugin reading the request's tenant out of AsyncLocalStorage — as a backstop that
intersects rather than overwrites. Neither replaces the other. The discipline is what makes a
correct call site correct; the structural layer is what keeps an incorrect one from being a leak
instead of a bug.

**The fail-open/fail-closed split, and why the same mechanism goes both ways.** A structural
interceptor reads context from *somewhere* — here, a per-request store. Two situations follow from
that fact alone, and they demand opposite defaults. Inside the context it depends on, the
interceptor has a real value to enforce and forgetting to apply it would be the failure — so it
fails **closed**: it intersects, narrowing what a caller can retrieve, and a caller who tries to
name a different tenant explicitly gets the empty set rather than a silent override. Outside that
context — a background worker, a migration, anything that legitimately runs with no request in
flight — the interceptor has *nothing to enforce*, and treating "no context" as "context says
deny everything" would be enforcing a value that was never provided, breaking every legitimate
context-free caller on every run. So it fails **open**: no context means no-op, not refusal. This
isn't an inconsistency to resolve — a mechanism whose correctness depends on context correctly
changes behavior when that context is absent versus wrong, and collapsing both into one default
would get one of the two situations wrong on purpose.

**In our code.** `tenantScopePlugin` (`src/database/plugins/tenant-scope.plugin.ts`) hooks every
tenant-scoped Mongoose query and, when AsyncLocalStorage holds a tenant, rewrites the filter to
`{ $and: [existingFilter, { tenantId }] }` — narrowing, never assigning over. When the store holds
no tenant — the Temporal worker, the eval harness, migrations — the hook is a no-op, and those
paths pass `tenantId` themselves, explicitly, the same discipline every request-driven service
method already used. The plugin's own doc comment enumerates exactly where it has no reach at all:
`aggregate()` (a different control covers that path, since a plugin-prepended stage would break
`$rankFusion`), the GridFS bucket (constructed against the raw driver connection, not a Mongoose
model), `insertMany` (nothing to filter — a passthrough of documents), and a query built inside a
request but awaited after the async context has already unwound.

**How we validated it — the negative control.** A test suite passing tells you the code behaved as
asserted on the inputs it ran. It does not, by itself, tell you the assertion would have caught the
bug it exists to catch — a suite that would pass regardless of whether the invariant holds is
worthless as a check on that invariant, and looks identical to a working one right up until it
matters. The distinguishing move is to break the thing on purpose and watch the suite fail at the
place you predicted. Here: revert one service method to an unscoped query, leave the structural
plugin in place — the isolation suite stayed green, because the backstop caught it. Read alone,
that green run is ambiguous — it's consistent with "the backstop works" and also with "this suite
never actually exercises this path." Then revert the same method *and* disable the plugin — the
suite failed, at exactly the assertion the whole exercise was about, with the wrong status code
returned. That second, failing run is what resolves the ambiguity: it proves the suite can fail on
this exact bug, which means the first run's silence was informative rather than vacuous. A negative
control isn't a nice-to-have around the real test — for a backstop mechanism specifically, it's the
only way to know the backstop was ever really doing anything.

**Interview answer.** I distinguish discipline from structural enforcement by what each one can
actually see: discipline is correct per call site and wrong the moment one site is missed; a
structural interceptor can't be individually forgotten, but it only covers what it's wired to
intercept, and outside that it's not protecting anything, it's just absent. I keep both here on
purpose, with the structural layer narrowing a caller's filter rather than overwriting it, so
disagreement between the two degrades to "too little data" instead of "wrong data." The fail-open
versus fail-closed split isn't an inconsistency — the same mechanism enforces a real value when it
has one and correctly does nothing when it has none, and forcing one default onto both situations
breaks whichever one you didn't design for. And I don't trust a backstop's test coverage until I've
broken the backstop on purpose: a suite that passes with the mechanism removed too was never
proving what I thought it was proving. Ours failed exactly where predicted, at the exact assertion,
only when both layers came out together — that's what makes the passing run mean something.

**Known limit.** A structural interceptor's coverage list is a claim about the present code, not an
invariant the type system enforces — a new operation type, a new driver-level access path, or a new
schema authored without the convention the interceptor depends on (here, a `default` on the scoped
field) can silently fall outside it, and nothing fails loudly when that happens. The interceptor's
doc comment has to be read and re-verified against the codebase it describes, not trusted as
permanently accurate.

---

## 013 — A tool surface for a model is not an API with a different transport

**ADR:** [0016](./adr/0016-mcp-server-surface.md) · **Code:** `src/mcp/`

**The concept.** An HTTP API is designed against a caller that read the documentation, holds its own
credentials, and means what it sends. A tool surface exposed to an AI client keeps the credentials
assumption and loses the other two. The immediate caller is a model, and that model's context can
hold text somebody else wrote — a document it is summarizing, a page it fetched, a prior tool result.
A request arriving at such a surface is not a statement of what the user wants; it is a statement of
what the model was talked into asking for. Three rules follow, and an ordinary API review produces
none of them on its own.

**Dangerous requests should be unrepresentable, not rejected.** A validator that accepts a field and
then checks it is worth exactly as much as the check, and every check is one refactor away from being
weakened by someone who did not know why it was there. A schema with no such field cannot be argued
past, because there is nothing to argue with: the request the attacker needs cannot be expressed in
the protocol at all.

**Identity is resolved outside the model-controlled payload.** Whatever the surface uses to decide
*whose* data a call reaches has to come from the credential the server itself verified, never from an
argument. The moment a tenant, an account, or a user id is an argument, the surface's isolation
property is only as strong as the model's resistance to being told to fill that argument in
differently — which is not a property anyone can guarantee.

**Rate limits are charged per logical request, not per transport call.** JSON-RPC, and every batching
protocol like it, lets one transport call carry an array of independent requests, each of which the
server will dispatch. A limiter that counts transport calls counts the wrong noun: one POST buys one
unit of budget and spends an arbitrary number of handler invocations. This is a general trap in any
protocol where the unit of transport and the unit of work are not the same thing.

**And what the surface withholds is itself the security design.** A surface that can propose an
action *and* approve it collapses a two-key control into one key, no matter how carefully each
individual tool is validated. If the reason a decision is safe is that a human authorizes it, then
the capability to authorize must not be reachable from the same place the proposal came from —
withholding it is not a missing feature to fill in later, it is the property that makes the rest of
the surface defensible.

**The trade-off.** A wide surface — one generic query tool, or a mechanical mirror of every existing
route — is far cheaper to build and strictly more capable, and it is how most integrations start. It
trades away the property above: capability becomes reachable by omission, the way any route with a
valid session is reachable by anyone holding one. A narrow, enumerated surface makes every capability
a deliberate code change with its own role floor, at the cost of a change per capability and a real
chance of being less useful than the model's user hoped.

**What we chose, and why here.** Three enumerated tools, each a declared definition routed through
the tool chokepoint entry 005 describes, with the execution context built from the verified token
alone. Two read tools and one write tool, split across two policy steps with different role floors,
so a read credential and a proposing credential stay distinguishable in policy. The write tool
proposes only — it starts the same durable approval wait the interactive path starts, and nothing on
this surface can decide that approval.

**In our code.** `mcp-server.service.ts` — `authenticate()` verifies a bearer token and returns a
`ToolExecutionContext`; `buildServer(context)` closes over it, and every handler reads `actorId` and
`tenantId` from that closure. `request.params.arguments` — the one part of a call the model controls
— never contributes to who the caller is. Because the chokepoint applies strict argument schemas
recursively, a call that *adds* a `tenantId` argument is not silently overridden, it is refused
before the handler runs: there is no such property in the schema for it to land in.

`count-rate-limit-cost.util.ts` — `countRateLimitCost()` returns `1` for an ordinary body and, for an
array body, the number of elements that are JSON-RPC *requests* (both a `method` and an `id`).
Notifications and responses batched alongside them dispatch no handler and cost nothing. That count
is what the fixed-window limiter charges, so a batch of N requests spends N units rather than one.

`mcp-tools.ts` — a read step allowing exactly the two read tools and a mutating step allowing exactly
the one proposing tool, kept disjoint. No tool anywhere in the module reaches the endpoint that
records a human's approval decision.

**How we validated it.** `test/mcp/mcp-server.service.spec.ts` asserts that each tool executes
against the tenant derived from the verified token rather than any argument, and separately that a
call carrying a `tenantId` argument is refused rather than reaching the handler — the two halves of
"unrepresentable" as opposed to "ignored". One test enumerates the frozen tool set on each step and
asserts no approval-deciding tool exists on either, which is the withheld-capability boundary written
as an executable check rather than a comment. `count-rate-limit-cost.util.spec.ts` drives the batch
accounting directly, including the case named for what it closes: a batch costs the number of
requests it carries.

**Interview answer.** The caller of a tool surface is a model whose context can contain text an
attacker wrote, so I design it as if the arguments are hostile even when the user is not. That means
three things concretely: dangerous requests are unrepresentable rather than rejected — there is no
tenant argument to override, so an injected instruction has nothing to fill in; identity comes from
the credential the server verified, never from the payload; and the rate limiter charges per logical
request, because a batching protocol lets one transport call dispatch an arbitrary number of
handlers, which is the trap that makes a per-POST limiter meaningless. The part I would lead with,
though, is what the surface deliberately does not have. Approval gates are a two-key control — the
thing proposing an action must not be the thing approving it — so the write tool can start an
approval and nothing on the surface can decide one. Adding a decide tool would collapse the control,
however well it was validated.

**Known limit.** The rate-limit counters live in memory on a single process, so the limit means what
its name says only for a single replica; horizontal scaling would need a shared counter store. And
the only granularity that exists is a per-step role floor — there is no credential scoped narrower
than its role, so a token that clears a step's floor can call every tool that step allows.

---

## 014 — Agentic retrieval: the loop gathers, and that boundary is the safety property

**ADR:** [0015](./adr/0015-agentic-retrieval-mode.md) · **Code:**
`src/features/evidence/qa/agentic-retrieval.service.ts`, `agentic-retrieval-tools.ts`

**The concept.** Single-shot retrieval runs one search per question and hands whatever it finds to
whatever comes next. It is correct for a question the corpus answers in one search and blind to a
question whose second search only becomes obvious once the first has run — a figure in one document
that needs a second document to interpret. Agentic retrieval closes that gap by letting a model
choose the next search, informed by prior results.

What it buys is reachability: evidence a single query would not have surfaced. What it costs is a
model turn per iteration, each with its own latency and spend, paid on every question including the
ones a single search already answered. Both halves are the honest description; a comparison that
reports only the quality number is not a comparison.

The structural question is where the model's output is allowed to go. The obvious failure is to let
the model's prose become the evidence — a loop that reads chunk-shaped text out of the model's
message and treats it as retrieved material has built a circle where the model authors its own
sources and then cites them. Every downstream verifier is then checking the model against itself.

**Two phases, and the boundary between them is the whole design.** Phase one gathers: a model chooses
a tool, the *server* executes it, and the real return value of that execution is what accumulates.
Phase two — synthesis and verification — is unchanged code operating on the same array shape it
always did. That split has two payoffs. The safety gate cannot be argued around, because it was never
told which retrieval mode produced its input and has no branch to take. And the comparison is fair,
because retrieval is genuinely the only variable: two runs of the same question differ in how the
evidence array was assembled and in nothing downstream of it.

**The trade-off.** Letting the model summarize as it goes — carrying its own notes forward instead of
raw retrieved objects — is cheaper per turn and reads better in a transcript. It also destroys the
property above: a note is model-authored text, and once a note is in the accumulator there is no
longer a distinction between what was retrieved and what was said about it. Accumulating raw objects
costs context and turns; it is what keeps verification meaningful.

**What we chose, and why here.** A gathering loop with two tools, both executed through the
deterministic chokepoint, with a hard iteration cap and a cost ceiling that shrinks as the loop
spends. The mode is a deployment-level setting, defaulting off, populated by the server rather than
by anything in a request body — so an ordinary question takes the single-shot path unchanged.

**In our code.** `agentic-retrieval.service.ts` — `gatherEvidence()` writes into its `gathered` map
only from `executeToolCall()`, from a tool's own return value. Nothing in the loop reads the model's
free-text output looking for chunk data, so a chunk-shaped JSON blob in a model message has no path
into the evidence set at all. The second tool, `fetch_chunks`, performs no lookup of its own: its
handler validates ids and returns them, and resolution happens against a map populated only by this
same loop's earlier search results, so an id that never appeared in this run comes back unknown
rather than as a lookup against the whole corpus.

Budget is one shrinking ceiling rather than two competing ones: each turn's cap is the smaller of a
fixed per-turn ceiling and what remains of the total, and that composed number is what the provider's
own fail-closed spend check enforces. Exhaustion — detected before a call or caught from the
provider's refusal — ends the loop and degrades to synthesis over whatever was gathered; it never
surfaces as an error.

**How we validated it.** `test/features/evidence/qa/agentic-retrieval.service.spec.ts` stubs the
model to return a chunk-shaped JSON string with no tool call at all and asserts the gathered set
stays empty — fabrication resistance as a direct assertion rather than an inference from the design.
Separate cases drive each termination reason, including the one that exists because of a real bug:
when every attempted tool call was refused, the run reports that explicitly instead of reporting the
empty result it would otherwise be indistinguishable from. `eval/retrieval/gather-evidence-for-strategy.ts`
normalizes both strategies to the same evidence shape and carries `turns` and `costUsd` alongside it,
so the comparison reports iteration count and spend next to whatever quality metric it computes.

**Interview answer.** Agentic retrieval means a model chooses what to search next, informed by what
earlier searches found — and the design question that matters is not the loop, it is what the model
is allowed to produce. In mine it produces tool calls and nothing else: every piece of evidence that
reaches synthesis was written into the gathered set by the server executing a tool, never parsed out
of the model's message text. I test that directly by feeding the model a chunk-shaped JSON string
with no tool call behind it and asserting nothing was gathered. The loop only gathers; synthesis and
the grounding check are the same unchanged code they were before, which is what stops the mode from
quietly weakening the verification step and also what makes an A/B fair — retrieval is the only
variable. And I would not report a quality number for it without reporting turns and dollars beside
it, because on a small corpus a single good search may already find everything, and then the honest
result is "no better, and more expensive."

**Known limit.** Iterative search earns its keep on a large, heterogeneous corpus. On a small one, a
single well-formed search may already surface everything a second search would reach, in which case
the loop pays extra turns to arrive at the same evidence. Whether it helps is a measurement, not a
design claim, and the design does not get to answer it.

---

## 015 — One interface, two vendors: what actually leaks through a neutral tool loop

**ADR:** [0006](./adr/0006-model-access-behind-a-decorated-provider.md) · **Code:**
`src/providers/model/model-provider.interface.ts`, `openai-model.provider.ts`,
`to-openai-structured-output.util.ts`

**The concept.** A tool loop is the same four steps at every vendor: offer tool definitions, receive
a request to call one, execute it, feed the result back as a message the next turn can see. That
symmetry is real, and it is why a neutral interface is possible at all. What a neutral interface has
to get right is the small set of places where the vendors genuinely disagree, because each one is a
decision about which side of the seam absorbs the difference.

Four things have to be true for two protocols to sit behind one port. The **tool definition** must be
expressed in a form both can be derived from — a schema, not a vendor envelope, since both wrap the
same JSON Schema differently. The **call** must have a stable identity, since a result has to be
matched back to the request that produced it. The **result message** must have a neutral role even
though one vendor gives it a role of its own and another expresses it as a block inside an ordinary
message. And the **stop condition** must be a closed set, mapped from each vendor's own string, with
anything unrecognized mapping to nothing rather than to a guess.

**The asymmetries that leak.** Two are worth naming because they are the kind that pass type-checking
and fail at runtime. First, one vendor returns a tool call's arguments already parsed as an object;
another returns them as a JSON-encoded *string* that the adapter must parse — which means the adapter
also owns a failure mode the other one does not have, since a string that does not parse is a
malformed vendor response and not a caller error. Second, structured-output modes differ on whether a
non-object schema root is legal: a discriminated union at the root is fine for one vendor's
constrained decoding and rejected by another's strict mode, which demands an object root. Absorbing
that means wrapping the union under a single property and unwrapping it again after parsing, so the
caller never learns the wrapping happened.

**The general lesson.** An abstraction over two vendors is only real if both mappings are written at
the same time. Write one and infer the second later and the interface has quietly been shaped to the
first vendor's data model: its field names, its notion of a message role, its assumption about where
a schema may be a union. The second implementation then arrives as a pile of special cases, and the
"neutral" port is a thin rename of vendor one. The cheap version of this discipline is writing the
per-field vendor mapping down beside the field itself as the interface is authored — if a field
cannot be described in both vendors' terms in one sentence, it is not neutral yet.

**The trade-off.** Using one vendor's SDK types directly is faster, better typed, and free of
translation bugs — right up until the second vendor, when the cost lands all at once and is paid by
every call site rather than by the adapter. A neutral port pays a smaller cost continuously: a
translation layer to maintain, and a real risk of a lowest-common-denominator interface that gives up
a capability only one vendor has.

**What we chose, and why here.** One `ModelProvider` port whose tool types carry the vendor mapping
for both protocols in their own doc comments, with each provider a thin adapter beneath it. Both
mappings exist; neither vendor's field names appear above the seam. The second provider talks to any
compatible chat-completions endpoint over plain `fetch` rather than a vendor SDK, which also makes a
self-hosted, keyless endpoint an ordinary deployment rather than an edge case.

**In our code.** `model-provider.interface.ts` — `ModelToolDefinition`, `ModelToolChoice`,
`ModelToolCall`, `ModelMessage` and `ModelStopReason` each carry both vendors' shapes in the doc
comment on the type itself, including the two roles that differ: a tool result is a role of its own
for one vendor and a block inside a user message for the other.

`openai-model.provider.ts` — `extractToolCalls()` parses the arguments string into `input` and
raises a typed malformed-arguments error when it does not parse, rather than handing a caller an
unparsed string or letting a `SyntaxError` escape `generate`. `toModelStopReason()` is closed over
the three reasons the neutral type documents; anything else, including a server that omits the field
entirely, maps to `undefined` rather than a fabricated value.

`to-openai-structured-output.util.ts` — `toOpenAiStructuredOutputFormat()` detects a union root in
the emitted JSON Schema, wraps it under a single `result` property to satisfy the strict-mode object
root, and returns `wrapped` so the provider can unwrap after parsing. The envelope never escapes the
adapter.

**How we validated it.** `test/providers/model/openai-model.provider.spec.ts` asserts a tool-call
completion maps into the neutral result with `input` as a parsed object, and separately that an
arguments string that does not parse raises the typed error. One case sends the *same* neutral tool
request the other provider's spec sends and asserts the vendor-shaped body it produces, which is the
parity check the seam exists for. `to-openai-structured-output.util.spec.ts` asserts the union-rooted
contract gets wrapped and the object-rooted one does not, and the provider spec asserts the caller
sees the unwrapped value either way.

**Interview answer.** A tool loop is the same four steps everywhere — offer tools, get a call, run
it, feed the result back — so a neutral port is genuinely possible, and what matters is the handful
of places the vendors actually disagree. The two that bit me are worth being concrete about: one
vendor hands back tool arguments as a parsed object and the other as a JSON string, so the adapter
owns a parse failure the first one never has; and structured-output strict mode rejects a union at
the schema root, so a discriminated-union contract has to be wrapped under a property and unwrapped
after parsing, invisibly to the caller. The rule I would carry to any two-vendor abstraction is that
both mappings have to be written at the same time. If you write one and plan the second, the
interface silently becomes the first vendor's data model with different field names, and the second
implementation arrives as special cases. I wrote the per-field mapping for both protocols into the
interface's own doc comments as I authored it — a field I could not describe in both vendors' terms
in one sentence was not neutral yet.

**Known limit.** A neutral port only spans the capabilities both sides express. The structured-output
conversion here handles the schema shapes the contracts actually use; a schema introducing an
optional field would need a further transform for strict mode that the converter does not yet
perform, and it would fail as a vendor rejection rather than as a type error.

---

## 016 — A per-request cost cap is not a budget

**ADR:** [0006](./adr/0006-model-access-behind-a-decorated-provider.md) · **Code:**
`src/providers/model/spend/tenant-spend.service.ts`, `spend-guard-model.provider.ts`

**The concept.** A per-call ceiling — refuse this request if its worst-case estimate exceeds some
number — bounds one call and says nothing about a day. A thousand calls each comfortably under the
cap is a thousand times the cap, and every one of them was individually permitted by a guard doing
exactly what it was asked. Bounding aggregate spend is a different mechanism: it needs shared,
durable state, because the thing being bounded is a sum across requests, processes, and time.

That state is a ledger, and a ledger that gates an irreversible action has three obligations.

**The check and the decrement are one operation.** Read the balance, decide it fits, then write the
new balance, and every concurrent caller reads the same pre-decrement balance and every one of them
fits. The window between the read and the write is the whole vulnerability, and it does not need an
attacker — ordinary concurrency is enough. The fix is a conditional update: one round trip whose
filter *is* the budget check and whose increment applies only to a document that satisfied the filter
in that same operation.

**The settle lands on the window the reserve keyed.** Any windowed budget has a boundary, and a call
can start before it and finish after it. If the settlement recomputes "which window is it now" from
the clock, it credits a window the reservation never touched and leaves the reserved one permanently
short — a slow leak that shrinks tomorrow's available budget every time a call straddles midnight.
The reservation has to return its key, and the settlement has to take it as an argument.

**A throw releases.** Reserve, call, settle is the happy path; reserve, call, *throw* is the one that
matters. Without an explicit release on the failure path, every failed call permanently consumes
budget for work that never happened, and a vendor outage silently converts into a spend ceiling that
can only be cleared by waiting for the window to roll.

**The ordering insight, which generalises past money.** A spend guard has to sit *inside* a cache,
not outside it. A cached response costs nothing to serve, so a guard outside the cache bills for
requests that never reach a vendor — and the more effective the cache is, the more wrong the ledger
becomes. The general form: a decorator that meters a real-world side effect belongs closer to the
effect than any decorator that can prevent the effect from happening. Getting that order backwards is
invisible in tests that stub the inner provider, because the stub costs nothing either way.

**The trade-off.** A ledger is a shared write on the hot path of every model call — an extra round
trip, and a single point of contention for a busy tenant. An in-process counter is free and instantly
wrong the moment a second process or replica exists, since each one enforces its own private share of
a ceiling nobody agreed to divide. Estimating spend from logs after the fact costs nothing at all and
cannot refuse anything, which makes it reporting rather than a control.

**What we chose, and why here.** A per-tenant daily window in the database, reserved on the
worst-case cost before the call and settled to the actual cost after, wrapped around the model
provider as a decorator so no feature code participates. It fails closed: a request that cannot be
attributed to a tenant is refused rather than let through unmetered, because the thing being gated —
money leaving an account — is irreversible once the call runs. The single deliberate fail-open path
is an explicitly disabled ceiling, which is how a tenant with no cap is expressed.

**In our code.** `tenant-spend.service.ts` — `reserve()` first upserts the window document with zero
balances (so a day's first call needs no separate create branch), then performs the check and the
increment as one `findOneAndUpdate` whose filter carries an `$expr` asserting that the existing
spend, existing reservations and this amount still fit under the ceiling. That second call must not
upsert: an upsert on a filter containing the budget expression would mint a fresh zero-balance
document whenever no document matched, satisfying the check trivially and bypassing the ceiling it
exists to enforce. A `null` result means the filter matched nothing — the reservation did not fit —
and throws. `reserve()` returns the window it keyed; `settle()` and `release()` both take that value
rather than recomputing one.

`spend-guard-model.provider.ts` — reserves the request's own cap, calls the delegate inside a `try`,
settles with the actual cost on success and releases on any throw before rethrowing. The composition
order is stated where the chain is built: tracing outside, then caching, then the spend guard, then
the real provider — the guard inside the cache, so a replayed response consumes no budget.

**How we validated it.** `test/providers/model/spend/tenant-spend.service.spec.ts` asserts the
conditional increment shape directly, that a filter matching nothing raises the limit error rather
than permitting the call, and — the case that names the failure it prevents — that a settlement lands
on the window the reservation returned even when the clock has crossed the boundary since.
`spend-guard-model.provider.spec.ts` covers the release-and-rethrow path, the refusal of a request
with no tenant attribution, and that a refused reservation never calls the delegate at all.

**Interview answer.** A per-call cap bounds one call; it says nothing about the total, and a thousand
individually-permitted calls is a thousand caps' worth of spend. So aggregate governance is a ledger,
and a ledger gating something irreversible has to guarantee three things. The check and the decrement
are one atomic operation — a read followed by a write leaves a window where every concurrent caller
sees the same pre-decrement balance and all of them fit. The settlement lands on the window the
reservation keyed, passed back explicitly, because recomputing it from the clock credits the wrong
day whenever a call straddles the boundary and leaves the reserved window permanently short. And a
throw releases, or every failed call permanently burns budget for work that never happened. The
detail I would actually lead with is an ordering one: the spend guard has to sit inside the cache,
not outside it, because a replayed response costs nothing and a guard outside the cache bills for it
— and that is invisible in any test that stubs the provider underneath.

**Known limit.** The reservation is the worst-case estimate, not the actual cost, so a tenant's
effective ceiling is conservative while calls are in flight: concurrent requests can be refused
against reservations that will settle for far less than they reserved. That is the correct direction
to be wrong for a fail-closed spend control, but it is a real over-refusal, not a rounding detail.

---

## 017 — Survivorship: which disagreeing value wins is a policy question, not a model question

**ADR:** [0017](./adr/0017-survivorship-policy.md) · **Code:**
`src/features/evidence/conflicts/resolve-conflict-policy.ts`

**The concept.** Once a system can notice that two sources disagree about the same thing, the
obvious next question is which one is right — and it is tempting to treat that as an inference
problem, because a model will happily produce an answer. It is not one. "The system of record
outranks an exported spreadsheet, which outranks a narrative summary" is a claim about an
organisation's data governance, not about the text of either document. No amount of reading the two
documents recovers it, because it is not in them.

Treating it as policy has a consequence worth stating plainly: the rules belong in configuration, not
in code. Authority ordering is a ranking over source classes; staleness is a minimum gap two
observations must differ by before the newer one counts as meaningfully fresher. Both differ per
metric and per organisation, and both are the kind of thing a reviewer must be able to inspect and
change without reading a function.

**Silence and contradiction both mean no proposal.** A policy engine has to decline in two distinct
situations, and the second is the one people miss. If the policy says nothing about this case — no
ordering configured, a source class the ordering does not cover, a tie with nothing left to break it
— there is no answer to give. But if the policy is *self-contradictory* — an ordering that assigns
the same class two different ranks — the naive implementation resolves it without complaint: build a
map from class to first-seen index, and the duplicate is silently discarded, producing a confident
answer derived from an ordering that has no coherent claim about that class at all. A configuration
that cannot mean one thing must produce no proposal, not the first thing it happens to mean.

**An explanation that asserts more than the data supports is worse than no explanation.** The
proposal is read by a human deciding which figure to trust, and a stated rationale is exactly what
makes a suggestion persuasive. So an explanation that names a rule which did not really fire, or
implies a freshness comparison against a timestamp nobody recorded, does more damage than an honest
absence: it converts missing information into apparent evidence at the precise moment a person is
deciding whether to look further. The discipline is that a returned explanation may only reference
facts the inputs actually carried.

**And the human still decides.** The value of a deterministic proposal is not the automation — it is
the audit trail. A rule proposed, a named reason, and a person disposing is reviewable after the fact
in a way that neither a model's judgement nor a silent overwrite is.

**The trade-off.** Auto-resolution — write the winner back as the accepted value — reaches a resolved
state immediately and is far better demo material. It also makes a deterministic rule
indistinguishable, from the outside, from the failure mode a human approval gate exists to prevent: a
value changed by something that is not the person accountable for it. Proposing and stopping is
slower and leaves work on a human's plate; it is the only shape that keeps the trust model intact.

**What we chose, and why here.** A pure function that takes the conflicting facts and a per-metric
policy and returns either a proposed winner with the rule that produced it and a checkable
explanation, or an explicit refusal. It writes nothing. Its one caller recomputes it fresh on every
read rather than persisting it, so a proposal can never go stale against a since-changed ordering,
and records which rule fired only alongside an outcome a human already supplied.

**In our code.** `resolve-conflict-policy.ts` — the return type is a discriminated union, so a
refusal has no winner field to leave accidentally populated; the absence is structural rather than a
runtime convention. It validates the whole ordering for duplicate entries before it looks at a single
fact. An unclassified source is refused unconditionally, even when the ordering explicitly lists that
class: "nobody said what kind of source this is" is the absence of authority information, and ranking
it anywhere — including last — asserts something the data never recorded. A missing observation
timestamp stops a recency tie-break entirely rather than substituting any default, because a
fabricated observation date would let a freshness rule fire on evidence that never carried one. The
staleness window is a strict threshold, so two observations closer together than the window are not a
recency signal at all, however different their timestamps are.

**How we validated it.** `test/features/evidence/conflicts/resolve-conflict-policy.spec.ts` proves
every refusal branch independently, and one of them is a negative control rather than a coverage
line: it constructs an ordering that names the same class twice and asserts the function declines —
the exact input the obvious first-seen-index implementation resolves confidently. Another asserts
that an unclassified source is refused even when the ordering lists it. A third pins the explanation
against the data: when a metric configures no staleness window, the returned text says recency cannot
break ties here, rather than implying a comparison that never ran.

**Interview answer.** Which of two disagreeing values wins is a governance claim, not something
recoverable from the documents — the system of record outranking an export is a fact about an
organisation, so it belongs in configuration as an authority ordering plus a staleness window, and
the engine is a pure deterministic function over them. Two things I would call out. The engine has to
return no proposal when the policy is silent *and* when it is self-contradictory, and the second is
the interesting one: a duplicate entry in an ordering resolves cleanly under the obvious
implementation and yields a confident answer built on an ordering with no coherent claim, so I test
that case as a negative control rather than trusting the fail-closed behaviour is real. And the
explanation is held to the same bar as the proposal — a rationale asserting something the data does
not support is worse than none, because it turns missing information into apparent evidence exactly
when someone is deciding whether to dig further. The human still decides; the value is the audit
trail of a named rule proposing and a person disposing, which is reviewable in a way that neither a
model's judgement nor a silent overwrite ever is.

**Known limit.** The engine's correctness is a claim about the function, not about any given metric's
configuration. An incoherent policy does not crash — it makes every conflict for that metric resolve
to no proposal, which is safe and completely silent unless something surfaces the reason. And an
authority tie among three or more facts breaks on the gap to the next-most-recent, so adding a new,
closely-timed fact can change the proposal without the actual freshest fact changing.
