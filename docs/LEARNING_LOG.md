# Learning Log

One entry per AI-engineering concept this system uses: the concept, the trade-off, why this project
chose what it did, and the catch. Detail belongs in the linked ADR, not here.

---

## 001 — Hybrid retrieval, and why rank fusion fuses ranks instead of scores

**ADR:** [0002](./adr/0002-single-store-hybrid-retrieval.md) · **Code:**
`src/providers/retrieval/mongo-hybrid.store.ts`

Lexical and dense retrieval fail in opposite directions. BM25 is unbeatable on a rare literal token —
`5.25%`, a proper noun, a clause number — and blind to a question sharing no vocabulary with its
answer; embedding similarity finds "how aggressive was the pricing" in a paragraph that never says
"aggressive", and will rank a semantically adjacent passage above the one holding the exact figure.
You cannot add the scores: BM25 is unbounded and corpus-dependent, cosine is bounded and clustered,
so summing silently elects one pipeline and the winner changes on any index rebuild. Reciprocal rank
fusion — `score(d) = Σ_p w_p / (k + rank_p(d))` — discards the scores and keeps only each pipeline's
ordering, which makes it invariant to any monotonic rescaling of either signal. `k = 60` flattens the
head of each list so cross-pipeline agreement outweighs depth in one.

The alternative is per-query score normalization, which preserves the margin information RRF throws
away — but over a small clustered candidate set it amplifies noise into a confident ranking, and
needs recalibration whenever either scorer changes.

The deciding constraint here was provenance, not ranking quality: every chunk carries a document
version, content hash and locator, and a split vector store forces either duplicated provenance or a
second round trip. Tenant scoping runs inside both input pipelines — post-filtering ranks a candidate
set you then discard, which changes the final top-k, so it is a correctness change disguised as an
optimization.

The catch: this embedding model is asymmetric, and passing the document-side input type when
embedding a query returns a perfectly well-formed vector that simply retrieves worse.

---

## 002 — Retrieved text is attacker-controlled: the prompt as a trust boundary

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/evidence/ingestion/sanitize-evidence-text.ts`,
`src/features/evidence/qa/prompts/assemble-answer-messages.ts`

Retrieved document text is input from an untrusted party: whoever authored the PDF chose every byte,
including bytes intended for the model that will later be shown it. The model cannot separate "text
to reason about" from "text telling me what to do" — both arrive as tokens in one context window. The
boundary has two halves. Placement: evidence never enters the system prompt, only a fenced user turn,
so an injected instruction competes with the system prompt rather than being it. Fence integrity: the
delimiter is escaped in the stored text, case-insensitively, because a model reads `</EVIDENCE>` as a
closing tag just as well as the lowercase form.

The trade-off is *where* to escape. Prompt-assembly time is the obvious choice and is wrong here: the
grounding gate compares the model's quote against the stored bytes, and that comparison only holds if
the stored chunk is the prompted chunk. Escaping once at ingestion costs byte-faithful storage — a
cost paid only by documents that literally contain the delimiter.

The bug worth carrying: chunk id and locator were XML attributes, and the escaper handled `<` but not
the `"` that ends an attribute value, so a crafted DOCX heading could close the attribute and write
text the model read as outside the fence. The fix was deleting the attribute position, not escaping
harder — then collapsing embedded newlines, since a bare-line format introduces a newline delimiter.
Enumerate the delimiters your new format has, not the ones the old one had. And no single control is
sufficient here; this is one layer beside the verifier, the tool allowlist and canary fixtures.

---

## 003 — Structured outputs: constraining generation instead of parsing prose

**ADR:** [0006](./adr/0006-model-access-behind-a-decorated-provider.md) · **Code:**
`src/features/evidence/qa/contracts/answer.contract.ts`, `src/providers/model/`

Three ways to get a machine-readable object out of a model, differing in where the guarantee lives.
Ask for JSON in the prompt and parse the reply: nowhere — a behavioural tendency that degrades under
long contexts. Force a tool call whose input schema is your target shape: in the tool-use machinery,
genuinely constrained but a shape mismatch, since you describe a function invocation to obtain a
value. Constrain decoding against a grammar compiled from the schema: in the sampler, where each
step's token distribution is masked to tokens keeping the output a valid prefix of some schema
instance, so malformed JSON is not unlikely — it is unreachable.

That buys syntactic validity and nothing else — a schema-valid answer can be entirely fabricated,
which is why entry 004 exists. The subtler cost is that a rigid schema forces the model into a shape
it did not conclude, and the mitigation is design, not library: this schema is a discriminated union
including `insufficient_evidence` and `conflicting_evidence`. With only an `answered` branch,
abstention is grammatically illegal and confident fabrication becomes the only legal output — the
schema you added for safety causes the hallucination.

The idea worth stealing: the schema is a capability boundary. Claim coverage and the verification
report are absent from the model's grammar entirely, so forging them is structurally impossible
rather than merely detected; the server computes and attaches them after the call. Native structured
outputs won here because the answer *is* a JSON object, and the same schema is what the eval harness
scores against.

---

## 004 — Grounding: verifying a citation is not verifying an answer

**ADR:** [0004](./adr/0004-grounding-gate-and-citation-contract.md) · **Code:**
`src/features/evidence/qa/grounding-gate.service.ts`, `verify-claim.ts`, `locate-quote.ts`

A model *claiming* a citation and a system *verifying* one are different events, and nearly all the
trust rests on the second — a fabricated citation is indistinguishable from a real one by inspection.
Verification is a deterministic pass with exactly one power: to drop. It calls no model and never
adds a claim, a citation or a fact. A component that can only subtract cannot hallucinate, which is
why it can stand between a model and a user. Per citation: the cited chunk must be among those
retrieved *for this request*, with matching version and content hash; the quote must appear verbatim
under normalization; every number must be supported. One failing citation drops the entire claim, so
padding a fabrication onto a good claim earns no partial credit.

The alternative — checking whether a claim actually *follows* from its evidence — needs an
LLM-as-judge. It covers the failure this cannot (correctly cited, wrongly reasoned) at the cost of
being probabilistic, injectable by the evidence it judges, and unexplainable to a user. Bounded edit
distance is computed here only to label a rejection as a near-miss; no similarity value is ever
treated as verified, since credit for a citation that merely sounds right is the failure mode itself.

When every claim fails, the gate returns `insufficient_evidence` on its own — the system can abstain
even when the model did not.

The catches, stated rather than hidden: it verifies citations, not reasoning, so an injected sentence
physically present in a source is truthfully present in the chunk and passes; numeric support is
digit-pattern matching, so a figure written in words bypasses it; and only the `answered` branch is
verified at all.

---

## 005 — Deterministic authorization: the model proposes, the application disposes

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/platform/authz/`

Entry 004 applies "the model proposes, the application disposes" to assertions; applied to actions it
is stricter, because an action has side effects and cannot be dropped afterwards. A restriction
expressed in a prompt is text competing with attacker-controlled text in the same window, so whether
a tool call is permitted is answered by deterministic code the model has no path into.

Four gates, and the order is the design: registry membership, the current step's allowlist, a
synchronous authorization hook, then strict argument validation. Access is decided on tool identity
and step context alone, before the still-attacker-controlled arguments are parsed — parsing is work
on untrusted input, and none of it should happen before the call is known to be permitted, so a
refusal also leaks nothing about the argument surface. The allowlist is per-step and supplied by the
caller, never read from anything the model produced.

A synchronous hook costs you the remote policy service — policy must be materialized locally — and
buys a fast, replayable decision with no time-of-check window. It is injected once through DI,
because a per-call hook is itself a bypass vector: the one caller who passes a permissive stub
reopens the gate invisibly.

The catches: a hook that throws is a refusal, because permission gates fail closed; the decision must
be the literal `true`, since `{ allowed: 'yes' }` is truthy and `if (decision.allowed)` would pass
it; and zod's `.strict()` applies one level deep only, so the chokepoint walks the schema recursively
at registration rather than trusting each tool author to remember.

---

## 006 — The determinism boundary in durable execution

**ADR:** [0003](./adr/0003-temporal-from-day-one.md) · **Code:** `src/workflows/`, `src/worker/`

A durable execution engine persists an event history, not your variables, and rebuilds live state by
re-executing the workflow function from the top with recorded results fed back in place of the calls
that produced them. That imposes one demand: workflow code must be a pure function of its history —
same history, same commands, same order. Read the clock, take a random number or make a network call
and the replay diverges, which the engine detects and fails. So a model call, non-deterministic even
at temperature zero across model versions, lives in an *activity*, whose result is what the history
records; a workflow killed after an expensive call resumes with the recorded answer rather than
paying twice.

In-process `async/await` is simple and correct until the process restarts mid-answer, at which point
the work is gone with no record of how far it got. A queue plus a hand-rolled state machine is durable
on infrastructure you already run, but the hand-written parts are durable state, retry policy,
resumption and waiting indefinitely for a signal — exactly the parts that are subtly wrong in ways
tests do not show. The requirement that settled it was a human approval gate lasting hours or days: a
polling loop over a status column in one design, a signal wait in the other.

Because activity execution is at-least-once, retry policy is set per activity from cost and
idempotency: the cheap idempotent read gets generous attempts, the paid synthesis call a low cap and
declared non-retryable error classes, so a bad prompt is never paid for twice.

The catch: the lint rule forbidding framework imports inside the workflow directory is a fast signal,
not the guarantee — it cannot see a Node builtin reached transitively through a dependency. The
bundler's total analysis over what actually ships into the isolate is the real gate.

---

## 007 — Provenance: content addressing, locators, and versioning the coordinate system

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:**
`src/features/evidence/ingestion/parsers/`, `src/features/evidence/qa/evidence-retrieval.service.ts`

A citation is a claim about *where*, worth exactly its ability to keep resolving — after a re-ingest,
a chunking change, a parser upgrade. That takes three independent pieces: a content hash ("are these
the same bytes?"), a structured locator ("where inside them?" — a page, a paragraph index plus
heading path, a cell), and an extractor version ("in whose coordinate system?"). The third is the one
people skip, and it is stamped on every locator rather than on the chunk, because the locator is what
travels with the citation. Without it, a parser upgrade that shifts offsets raises no error — it
resolves quietly to the wrong span, and the answer above it still looks cited.

The rule that generalizes: parse at the finest addressable unit, then group upward. Coarse parsing
cannot recover a locator that was never captured, and the cost — a large element count for
spreadsheets — is the right one to pay, since granularity you captured can always be coarsened.

The hash lives on the document version, not the chunk, so retrieval is the single place joining a hit
back to its version's hash — which is what makes the grounding gate's chunk/version/hash triple check
meaningful rather than circular. The well-regarded DOCX library was rejected on the same logic: it
extracts text beautifully and exposes no stable paragraph index, and a paragraph index is what the
locator *is*. Evaluate a library against the contract, not the category.

The catch: the PDF bounding box is the union of every text item on the page, so page-level citation —
not UI highlighting — is the real contract today.

---

## 008 — Ground truth is code, and an eval you never watched fail is not an eval

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:** `eval/`,
`fixtures/`

An evaluation dataset is a program artifact with its own correctness problem, and the one artifact
nothing downstream can check. Every metric is conditional on it: if the ground truth is wrong, a
correct system scores badly, an incorrect one may score well, and no signal tells you which world you
are in. So the dataset is code, tested against the artifacts it describes — not data you write down
and trust.

The failure that taught it: the fixture generator wrote each page's footer below the margin, the PDF
library treated that as overflow and started a new page, and the memo ended up with eight physical
pages while the manifest recorded four — every PDF citation in the ground truth pointing at a blank
page. Nothing failed, because the manifest was self-consistent and the dataset validated against the
manifest. Two derived artifacts agreeing with each other is not evidence about the thing they were
derived from; a locator has to be checked against the document it points into, using the parsers
ingestion uses.

The alternative is hand-authored ground truth under human review, which most teams do. It trades this
bug class for an unfalsifiable one: no test can tell you a hand-written expectation is wrong.

The habit worth keeping: an assertion that passes on its first run has not distinguished "the property
holds" from "the assertion cannot fail". Each new check here was deliberately made to fail before
being trusted — as was the go/no-go retrieval probe in entry 001, built to reject a false go and a
false no-go, and the fence tests in entry 002, mutated until red.
