# Learning Log

One entry per AI-engineering concept this system actually earned. Each entry follows the same
shape: the concept itself, the architectural trade-off and what the alternatives cost, why this
option won under this system's constraints, how it was validated, and a short interview-ready
framing.

Entries are ordered so the concepts build on each other — retrieval, then the prompt boundary, then
constrained generation, then verification, then action, then orchestration, then the two questions
underneath all of it: how a citation stays resolvable, and how you know your ground truth is true.
The order is deliberately not chronological.

Architecture Decision Records live alongside in [`docs/adr/`](./adr/). An ADR records what this
repository decided and why; an entry here is the concept behind it, written to be portable to a
system that shares none of this code.

---

## 001 — Hybrid retrieval, and why rank fusion fuses ranks instead of scores

**ADR:** [0002](./adr/0002-single-store-hybrid-retrieval.md) · **Code:**
`src/providers/retrieval/mongo-hybrid.store.ts`

**The concept.** Lexical retrieval and dense-vector retrieval fail in opposite directions, which is
the entire reason to run both. BM25 scores a document by term overlap weighted by inverse document
frequency: it is unbeatable on a rare literal token — a figure like `5.25%`, a proper noun, a
contract clause number — and blind to a question that shares no vocabulary with the passage that
answers it. Embedding similarity scores a document by the cosine of two learned vectors: it finds
"how aggressive was the pricing" in a paragraph that never uses the word "aggressive", and it will
happily rank a semantically adjacent passage above the one containing the exact number you asked
for, because a rare literal token is a few dimensions of noise in a 1024-dimensional average.

Running both is easy. Combining them is the interesting part, and the naive approach does not work:
you cannot add or average the two scores. A BM25 score is unbounded, corpus-dependent, and shifts
when the index is rebuilt with different document statistics. A cosine similarity is bounded in
`[-1, 1]` and clusters tightly — in practice most real candidates sit in a narrow band near the top.
The two numbers are not on the same scale, do not have the same variance, and are not even the same
*kind* of quantity. Adding them means silently deciding that one pipeline dominates, and which one
dominates changes whenever either index changes.

Reciprocal rank fusion sidesteps the incommensurability by discarding the scores entirely and
keeping only the ordering each pipeline produced:

```
score(d) = Σ_pipelines  weight_p × 1 / (k + rank_p(d))
```

A document absent from a pipeline's result list contributes nothing from that pipeline. That is the
whole algorithm. It has no parameters to tune besides the weights and `k`, and it is invariant to
any monotonic rescaling of either pipeline's scores — which is exactly the property that makes it
survive an index rebuild or an embedding-model swap.

**What `k` actually does.** `k = 60` is inherited from the original RRF paper and it is not
arbitrary decoration: it damps the dominance of the top rank. With `k = 0`, rank 1 contributes `1.0`
and rank 2 contributes `0.5` — one pipeline's confident first place outweighs anything the other
pipeline can say. With `k = 60`, rank 1 contributes `1/61 ≈ 0.0164` and rank 2 contributes
`1/62 ≈ 0.0161`. The curve is nearly flat across the head of each list, so agreement between
pipelines matters far more than depth within one of them. Concretely, over the two pipelines here:

- ranked #1 by lexical search, absent from vector search → `1/61 ≈ 0.0164`
- ranked #3 by *both* → `1/63 + 1/63 ≈ 0.0317`

The consensus document wins by nearly 2×. Set `k = 0` and the ordering inverts — the lone #1 scores
`1.0` against the consensus document's `0.667`. So `k` is the knob that decides whether fusion means
"trust whichever pipeline is most confident" or "trust what both pipelines agree on", and 60 is
firmly in the second camp.

**The architectural trade-off.** The real alternative to RRF is score normalization: min-max or
z-score each pipeline's results over the candidate set, then combine. Normalization preserves
*margin* information that RRF throws away — RRF cannot distinguish a runaway top hit from one that
barely edged out second place, and that is a genuine loss of signal. The cost is that per-query
normalization over a small candidate set is unstable: with ten candidates whose scores cluster,
min-max amplifies noise into an apparently decisive ranking, and z-score assumes a distribution
shape the scores do not have. Normalization also needs recalibration whenever either scorer changes,
which is precisely the maintenance burden RRF exists to avoid. RRF is the robust default; score
fusion is what you graduate to once you have eval data showing the discarded margin was costing you.

The second trade-off is *where* fusion runs. Server-side (`$rankFusion`) means one round trip, the
ranking computed next to the data, and per-pipeline rank and contribution returned as metadata —
most of an explainability panel for free. Application-side means two queries and fusion in code:
more round trips and more code, but no dependency on a newer server capability, and the fusion logic
is yours to instrument and change. Both exist here behind a config flag.

**Why this option won here.** The deciding constraint was not ranking quality — it was provenance.
Every retrieved chunk has to carry its document version, content hash and locator, and every query
has to be tenant-filtered. A split store (vectors in a dedicated vector database, provenance in
Mongo) forces one of two bad options: duplicate the provenance into the vector store and keep two
copies consistent, or rehydrate it in a second round trip, which means you cannot filter *before*
ranking. That last point is not a performance footnote. Tenant scoping is applied inside both input
pipelines rather than as a filter on the fused result, because filtering after fusion ranks a
candidate set that includes other tenants' evidence and *then* throws most of it away — which
changes which documents make the final top-k, not just how fast you get there. A post-filter is a
correctness change disguised as an optimization.

Two operational details are worth carrying to any hybrid system. First, each input pipeline pulls a
candidate pool several times wider than the caller's final limit: if both pipelines return only the
top-`limit`, a document ranked #1 by vector search but sitting just outside lexical's top-`limit`
never gets the chance to be seen by both, and the consensus effect `k = 60` exists to produce cannot
fire. Second, the fallback path uses the identical `k` and identical weights as the server. That is
not tidiness — it is the precondition for the two modes being comparable in an experiment. Change
two knobs at once and you learn nothing from the comparison.

A related trap, cheap to hit and invisible when you do: this embedding model is asymmetric, with
separate `query` and `document` input types. Embedding a query with the document-side parameter
raises no error and returns a perfectly well-formed vector; it just retrieves worse. There is
exactly one call site in the application that must pass `query`, and nothing but a comment and an
eval score would ever tell you it was wrong.

**How it was validated.** The go/no-go probe was designed to reject *both* wrong answers, which is
the transferable part. A probe that skips index creation gets an error from a server that fully
supports the feature and concludes "unsupported" — a false no-go, which sends you into a rewrite you
did not need. A probe whose fusion inputs are only lexical pipelines succeeds on an older server that
cannot fuse a vector stage at all — a false go, which surfaces later and deeper. So the probe builds
both index types, polls until each reports queryable, seeds deterministic vectors, fuses a lexical
pipeline with a vector pipeline, and runs a lexical-only control so any failure can be attributed to
the right cause. The server's own score-description string then confirmed the formula and the
constant, rather than the documentation being taken at its word.

**Interview framing.** "You can't average a BM25 score and a cosine similarity — one is unbounded and
corpus-dependent, the other is bounded and clustered, so adding them silently picks a winner and the
winner changes when you rebuild an index. RRF throws the scores away and fuses the ranks, which makes
it invariant to any rescaling of either signal. The `k = 60` constant is what makes it a consensus
algorithm rather than a confidence algorithm: at `k = 60` the gap between rank 1 and rank 2 is under
2%, so a document ranked third by both pipelines beats a document ranked first by one and missed by
the other. And the thing I'd flag as a correctness issue rather than a performance one is that tenant
filtering happens inside both input pipelines — filtering after fusion ranks a candidate set you then
discard, which changes the top-k, not just the latency."

---

## 002 — Retrieved text is attacker-controlled: the prompt as a trust boundary

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/evidence/ingestion/sanitize-evidence-text.ts`,
`src/features/evidence/qa/prompts/assemble-answer-messages.ts`

**The concept.** In a RAG system the retrieved document text is input from an untrusted party. Not
"potentially malformed" — *adversarial*. Whoever authored the PDF, the spreadsheet or the DOCX chose
every byte in it, including bytes intended to be read by a language model that will later be shown
the document. The model has no mechanism for distinguishing "text I was told to reason about" from
"text telling me what to do"; both arrive as tokens in the same context window. That makes the
prompt a trust boundary in the same sense as an HTTP request body, and it has to be designed like
one.

The boundary has two halves, and only one of them is about escaping.

The first half is *placement*. The system prompt is the highest-privilege channel available: it is
where instructions live, and models are post-trained to weight it above the conversation. Document
text therefore never enters it. Evidence goes in a user turn, fenced, with the system prompt saying —
in advance, before the model has seen any evidence — that everything inside the fence is data. This
is the part that survives no matter how good the escaping is, because it means an injected
instruction is competing against the system prompt rather than *being* the system prompt.

The second half is *fence integrity*. Delimiting untrusted content only works if the content cannot
close its own delimiter. If a document literally contains `</evidence>`, everything after it reads as
outside the fence. So the delimiter pattern is escaped in the stored text. Case-insensitively — the
fence is interpreted by a model reading text, not by a strict XML parser, and `</EVIDENCE>` reads as
a closing tag just as well as the lowercase form. An exact-case escape leaves the most obvious bypass
wide open.

**The trade-off that actually took thought: escape once, and where.** The obvious place to escape is
at prompt-assembly time, right before the text is used. That is wrong here, and the reason
generalizes to any system that verifies a model's output against its own input.

This system checks a model's citations by asking whether the quoted text appears in the stored chunk.
That check is a string comparison between two things that must be byte-identical: what the model saw,
and what the verifier compares against. Escape at prompt time and those two diverge — the model
faithfully quotes the escaped form it was shown, the verifier looks for it in the unescaped stored
form, and every citation over affected content fails verification for a reason that has nothing to do
with whether the model was honest. So escaping happens exactly once, at ingestion, and the stored
chunk *is* the prompted chunk *is* the verified chunk. The cost is that the store no longer holds
byte-faithful source text — mitigated by the escape being the identity function for any document that
does not literally contain the delimiter, which is every non-adversarial document. Only a file
actively trying to escape the fence is altered at all.

**The bug worth teaching.** Each evidence block carries a chunk id (the thing the model must cite) and
a human-readable locator label. Those started life as XML attributes: `<evidence id="..."
locator="...">`. The escaper handled the delimiter pattern — the `<` and the tag name. It did not
handle `"`.

A DOCX heading is document text, so it is attacker-controlled, and it lands in the locator label. A
heading crafted as `Summary"> ... <x id="` closes the attribute early using its own quote character,
then closes the tag, and everything after it renders to the model as being outside the evidence fence
entirely — as ambient instructions rather than as data. The escaper was doing its job perfectly and
was simply guarding the wrong character class, because moving a value into an attribute position
introduces a *new* delimiter that the format did not previously have.

The fix was not to also escape the quote character. It was to delete the attribute-value position:
both fields moved onto their own bare lines inside the fence. There is now no quote character
anywhere in the format that a label could use as a structural delimiter, because there is no
attribute syntax left to escape out of.

And then the honest follow-up, which is the part I would insist on in a review: removing one class of
delimiter creates another. A bare-line format is newline-delimited, so a label containing its own
newline could inject a fake second `chunkId:` line and impersonate a different chunk. That is closed
by collapsing embedded newlines in the label to a single space, which makes each field *provably*
confined to the one line it was placed on. The general move is: enumerate the delimiters your new
format has, not the ones your old format had.

**Why this option won here.** Escaping a delimiter is a race against the next encoding trick;
removing the position a crafted input can exploit is structural and ends the race. That principle is
what the rest of the security posture is built on — it is the same reason the tool-access decision in
entry 005 is something the model cannot pass arguments into. A decision the model never touches has no
delimiter to escape out of, because there is nothing to escape from.

None of this is presented as *the* defense. It is one layer, sitting alongside the deterministic
citation verifier, a per-step tool allowlist, and canary fixtures. No single control is sufficient
against prompt injection, and a design that claims otherwise is the one to distrust.

**How it was validated.** The prompt builder is a pure function — no model call, no I/O — precisely so
the injection boundary can be asserted directly against its output. The DOCX-heading breakout is
reproduced end-to-end as a test that runs the actual exploit vector and asserts the payload stays
confined to its line. Separately, I confirmed the fence-confinement assertions are capable of failing
rather than merely capable of passing: temporarily dropping the closing tag from the assembled prompt
turned two green tests red with exactly the fence-boundary failures predicted, and the change was
reverted. An assertion never observed failing is not yet an assertion about anything.

**Interview framing.** "Retrieved document text is attacker-controlled input, so the prompt is a trust
boundary. Two halves: evidence only ever goes in a user turn inside a fence, never in the system
prompt, so an injected instruction is at best competing with the system prompt instead of being it;
and the fence gets escaped at ingestion rather than at prompt time, because the grounding gate
compares a model's quote against the stored bytes and that comparison only holds if escaping happened
exactly once. The concrete bug I'd tell you about: the chunk id and locator used to be XML attributes,
and the escaper handled `<` but not the `"` that delimits an attribute value, so a crafted DOCX
heading could close the attribute and write text the model read as outside the fence. The fix wasn't
better escaping — it was deleting the attribute position. Then I had to close the delimiter the new
format introduced, which was the newline."

---

## 003 — Structured outputs: constraining generation instead of parsing prose

**ADR:** [0006](./adr/0006-model-access-behind-a-decorated-provider.md) · **Code:**
`src/features/evidence/qa/contracts/answer.contract.ts`, `src/providers/model/`

**The concept.** There are three ways to get a machine-readable object out of a language model, and
they differ in *where the guarantee lives*.

Ask for JSON in the prompt and parse the reply: the guarantee lives nowhere. It is a behavioural
tendency, it degrades under long contexts and unusual inputs, and it fails by emitting prose around
the JSON, a trailing comma, or a truncated object.

Force a tool call whose input schema is your target shape: the guarantee lives in the tool-use
machinery, which is genuinely constrained. This was the standard trick for years and it works, but it
is a shape mismatch — you are describing a function invocation in order to obtain a value, and the
model's post-training tells it a tool call is a step toward an answer rather than the answer.

Constrain decoding against a grammar compiled from the schema — native structured outputs: the
guarantee lives in the sampler. At each decoding step the token distribution is masked to tokens that
keep the output a valid prefix of some instance of the schema. Invalid JSON is not unlikely; it is
unreachable. A required field cannot be omitted because the closing brace is not a legal token until
it is present.

**The architectural trade-off.** Constrained decoding buys syntactic validity and buys nothing else.
A schema-valid answer can still be entirely fabricated — the grammar has no opinion about truth. That
is worth saying out loud because "we use structured outputs" is frequently offered as though it were
a reliability property; it is a *parsing* property, and it is the reason the entire next entry exists.

The subtler cost is that a rigid schema can degrade answer quality by forcing the model into a shape
that does not fit what it actually concluded. The mitigation is a design decision, not a library
feature: this schema is a discriminated union whose branches include `insufficient_evidence` and
`conflicting_evidence` alongside `answered`. A schema with only an `answered` branch makes abstention
*grammatically illegal* — the model is unable to emit "I don't know" because no legal token sequence
expresses it, so it emits a confident fabrication instead, and the schema you added for safety is
what caused the hallucination. If you constrain generation, you must give the model a legal way to
decline.

**The idea worth stealing: the schema is a capability boundary.** The model's output is one part of a
larger answer envelope. The envelope also carries claim coverage and a verification report — numbers
computed by the server *after* the model call, by checking citations against retrieved bytes.

Those fields are not in the schema the model is shown. Not "present and rejected if the model sets
them" — absent from the grammar entirely. A value conforming to the envelope type is therefore
structurally impossible to produce by parsing the model's output alone; the server has to compute and
attach the fields itself. That converts a validation problem into a non-problem. The general pattern:
when a model's output feeds into a record that also contains trust signals, the trust signals must
live in a type the model's grammar cannot express. Detecting a forged self-assessment is work you can
get wrong; making it inexpressible is work you get right once.

**Retries are a taxonomy, not a number.** Wrapping a model provider invites a retry loop, and the
correct question is which *failure class* each layer owns. The vendor SDK already retries transient
transport failures — network errors, 5xx, 429 — twice, with backoff honouring `retry-after`. Adding a
retry loop above it does not add resilience; it multiplies attempts, and on a rate-limited paid API
multiplied attempts are multiplied spend. A rate limit is not a signal to try harder. So transport
retries stay the SDK's job, and the provider's own single retry is reserved for a different class
entirely: schema-validation failure, where the retry has actual information to add because it feeds
the validation errors back to the model. After one attempt it throws typed rather than returning
unvalidated output, and the test asserts the retry count is exactly one — because "exactly one" is
the invariant, not an implementation detail.

The budget cap is the same discipline pointed at cost. A request carrying a maximum cost is refused
*before* the call when the worst-case estimate exceeds it, rather than being truncated to fit. The
estimate is deliberately worst-case so it can only ever over-refuse: a gate that guesses low is not a
gate. The test asserts that no request was issued, not merely that an error was returned — the
difference between those two assertions is the entire value of the gate.

**Why this option won here.** The answer *is* a JSON object matching a discriminated union. It is not
a tool invocation and never was; forced tool use was the plan until native structured outputs turned
out to be generally available, at which point keeping the workaround would have meant carrying a
shape mismatch for no reason. Forced tool use remains where a call genuinely chains tools. The same
schema object is also what the eval harness scores against, which is why one runtime-validatable
source of truth mattered more here than consistency with the repository's request/response validation
conventions.

**How it was validated.** Against the live API rather than a mock: structured output parsed, token
usage returned, and the computed cost reconciled by hand against the published per-token prices to
the last digit. The embedding width was asserted against the provider's own declared dimensions,
because the vector index is built from that field — a mismatch there produces an index that silently
never matches anything, which is the failure mode with no error message attached.

**Interview framing.** "Structured outputs constrain the sampler against a grammar compiled from the
schema, so malformed JSON isn't unlikely, it's unreachable — but that's a parsing guarantee, not a
truthfulness guarantee, and conflating the two is the mistake. Two design points I'd defend. The
schema is a discriminated union that includes an abstention branch, because a schema with no legal
way to say 'insufficient evidence' makes fabrication the only grammatical option. And the
server-computed trust fields — claim coverage, the verification report — are deliberately not in the
schema the model sees, so forging them is structurally impossible rather than merely detected."

---

## 004 — Grounding: verifying a citation is not verifying an answer

**ADR:** [0004](./adr/0004-grounding-gate-and-citation-contract.md) · **Code:**
`src/features/evidence/qa/grounding-gate.service.ts`, `verify-claim.ts`, `locate-quote.ts`

**The concept.** A model *claiming* a citation and a system *verifying* one are different events, and
almost all of the trust a user places in a cited answer rests on the second. The claim is cheap: a
model asked to cite its sources will produce plausible chunk ids and plausible quotes with the same
machinery it uses to produce plausible prose, and a fabricated citation is indistinguishable from a
real one by inspection.

Verification is a separate, deterministic pass over the model's output, and the design constraint
that makes it trustworthy is that it has exactly one power: to *drop*. It never calls a model, issues
no prompts, makes no network request, and never adds a claim, a citation or a fact the model did not
already produce. A component that can only subtract cannot itself hallucinate, which is why it can
stand between a model and a user.

The checks are mechanical, per citation:

1. **Retrieval containment.** The cited chunk must be among the chunks retrieved *for this request*.
   Not "exists in the database" — a model citing a real document it was never shown has fabricated
   the citation regardless of the document's existence. And the chunk id alone is not the whole
   citation: the document version and content hash must match too, because a real chunk id paired
   with a fabricated version is still an unverifiable claim about provenance.
2. **Quote containment.** The quoted text must appear in the cited chunk under normalization —
   tolerant of reflowed line breaks and smart quotes, because those are artifacts of extraction
   rather than evidence of fabrication.
3. **Numeric support.** Every number in the claim must be supported, either by a cell-level extracted
   fact on a cited chunk or by the chunk's own text containing that number.

Failure is at *claim* granularity, not citation granularity: one failing citation drops the entire
claim. A model that pads one fabricated citation onto an otherwise well-grounded claim gets no
partial credit, because partial credit is precisely the incentive you do not want to create.

**The trade-off.** The alternative — a verifier that checks whether a claim actually *follows* from
its evidence — requires something close to a second model call, an LLM-as-judge. That covers the
failure this one cannot (correctly cited, wrongly reasoned) at the cost of everything that made the
deterministic version worth having: it is itself probabilistic, it can be prompt-injected by the same
evidence it is judging, it doubles per-answer cost and latency, and its verdicts cannot be explained
to a user in terms of anything checkable. A mechanical citation check is cheap, replayable, produces
a specific reason for every drop, and — the part that matters most — has bounds you can *state*.

The other real trade-off is fuzzy matching, and it is a trap worth naming. When a quote nearly matches
the chunk, accepting it feels generous and is how paraphrase and fabrication leak through a citation
checker: the entire value of demanding a *verbatim* normalized substring is that a model cannot get
credit for a citation that merely sounds right. So bounded edit distance is computed here, but purely
to *label* a rejection as a near-miss (worth surfacing to a human or an eval) rather than as
unrelated. No similarity value, however close to 1, is ever treated as verified. The threshold is
diagnostic; both outcomes are rejections.

**Abstention is an outcome, not a failure.** `insufficient_evidence` is a correct answer to an
unanswerable question, and the system treats it as a success state throughout — the prompt tells the
model it is valid, the schema makes it expressible, the eval harness rewards it. What is worth
noticing is the direction of the degradation: when every claim fails verification, the gate *itself*
returns `insufficient_evidence`. The system can abstain even when the model did not choose to. That
is what "the model proposes, the application disposes" means concretely — the persisted outcome is
the gate's, never the model's raw assertion.

**The bounds, stated rather than hidden.** This is the part I would insist on in any real design
review, because a verification layer described without its bounds is a sales pitch:

- **It cannot distinguish a quote of real evidence from a quote of an instruction embedded in real
  evidence.** A prompt-injection sentence physically present in a source document is, truthfully,
  present in the retrieved chunk. A claim quoting it passes checks 1 and 2 legitimately. The gate is
  not, and cannot be, a content filter — that is the trust boundary in entry 002's job, and this is
  why the two layers are separate.
- **Numeric support is digit-pattern matching, not comprehension.** A number written in words is
  invisible to it. `$41 million` parses as `41`, so a claim citing `$41 million` against evidence
  containing a bare `41` anywhere would be judged supported for entirely the wrong reason.
- **Only the `answered` branch is verified.** `insufficient_evidence` carries a model-authored reason
  and `conflicting_evidence` carries model-authored values, and neither branch has anything
  citation-shaped for this gate to check. Both reach the caller on the model's say-so. That is a
  known gap, not a hidden one.
- **The conflict override cannot currently fire on the wired path.** The rule that forces
  `conflicting_evidence` when a surviving claim touches a known-conflicted fact key requires that set
  of keys to be supplied, and the activity that invokes the gate does not supply it yet. The branch
  is reachable only from a direct call in tests. The code keeps an explicit guard that throws rather
  than silently mis-persisting, because the type still permits it and a future caller could wire the
  argument without noticing the guard.

Where a direction had to be chosen, it was chosen toward over-triggering: the conflict rule fires when
a claim's cited chunk merely *shares* a chunk with a conflicting value, not only when the citation
touches it. A false conflict costs a follow-up question; a false confident answer that silently picks
one side of a real disagreement costs trust in every subsequent answer.

**How it was validated.** The instructive part is not the coverage, it is that the primary bound has a
fixture that *forces* it rather than a sentence asserting it. A canary sentence is embedded in a real
PDF fixture; a claim echoes its marker token and cites the injected sentence itself as its quote; the
test asserts the claim **survives** every check. The bound is something I have watched happen, not
something I believe happens. Writing "the gate verifies citations, not reasoning" in a document costs
nothing and proves nothing.

**Interview framing.** "The gate is a verifier, not a generator — its only power is to drop, which is
why it can sit between a model and a user without being able to hallucinate itself. It checks that a
cited chunk was actually retrieved for this request, that the version and hash match, that the quote
is verbatim-present under normalization, and that every number is supported; one bad citation drops
the whole claim, so padding a fabricated citation onto a good one earns nothing. The bound I'd state
before being asked: it verifies citations, not reasoning, and I have a fixture that proves it — a
canary sentence embedded in a real document, quoted verbatim, passing every check, because the check
is 'is this text really in the chunk' and the answer is genuinely yes. Also: fuzzy similarity is
computed but never accepted. It only labels how a quote failed."

---

## 005 — Deterministic authorization: the model proposes, the application disposes

**ADR:** [0005](./adr/0005-deterministic-authz-and-tool-chokepoint.md) · **Code:**
`src/features/platform/authz/`

**The concept.** Entry 004 applies "the model proposes, the application disposes" to assertions. The
same principle applied to *actions* is stricter, because an action has side effects and cannot be
dropped after the fact. The moment a model can call a tool, the question of whether a given call is
permitted must be answered by deterministic code the model has no path to influence — not by the
model's own judgment about what it should be allowed to do, and not by an instruction in a prompt.

The reason the prompt-level version fails is entry 002 in one sentence: a restriction expressed in
text is competing with attacker-controlled text in the same context window. The reason a
framework-level "validate the arguments, then check the policy" fails is subtler, and it is about
ordering.

**Four gates, and the order is the design.** Registry membership, then the current step's allowlist,
then a deterministic authorization hook, then strict argument validation. Access is decided on tool
identity and step context *alone*, before the call's arguments — still fully attacker-controlled at
that point — are so much as parsed. Parsing is work, work on untrusted input is attack surface, and
none of it should happen before the call is known to be permitted at all. A pleasant second-order
consequence: a caller who is not authorized never receives an argument-schema error, so a refusal
leaks nothing about the tool's argument surface.

The allowlist is per-step rather than global, which is what makes a multi-step plan meaningfully
constrained: a tool available in one step is refused in every other step unless that step lists it
too. And the allowlist is presented by the caller, never read from anything the model produced — a
model that talks its way into believing it has a permission still cannot invoke it, because the
permission was never a function of what the model said.

**Design choices worth stealing.**

*The hook is synchronous.* An access decision is a computation over facts already in hand, not an I/O
operation. Keeping it synchronous removes a whole class of timeout and time-of-check/time-of-use bugs
from the one place a system can least afford them. The real cost, stated honestly: you cannot consult
a remote policy service inline, so policy has to be materialized locally. That is a constraint, and
it is also why the decision is fast and replayable.

*The hook is injected once via DI, never passed per call.* A per-call hook is itself a bypass vector.
The one caller who forgets to pass a real one, or passes a permissive stub while testing something
else and never removes it, silently reopens the gate — and nothing about that failure is visible at
the call site.

*A hook that throws is a refusal, identical to a hook that denies.* A broken permission check is not
an open one. This is the failure-direction rule applied literally: measurement gates fail open,
permission gates fail closed, and the direction should be stated in the code rather than inferred
from it.

*The decision must be the literal `true`.* Types do not exist at runtime, and a malformed hook
returning `{ allowed: 'yes' }` or `{ allowed: 1 }` is truthy. A permission check written as `if
(decision.allowed)` passes it.

*The default binding refuses everything.* No authorization policy has been designed yet, so the only
honest default is refusal with a stated reason. "Allow until told otherwise" is exactly the failure
mode fail-closed exists to prevent, and it is the default a future caller would silently inherit.

*Strictness is applied at registration, recursively.* Zod's `.strict()` sets its unknown-key policy on
the object it is called on and no deeper — a nested object schema keeps the default behaviour and
*silently drops* an unrecognized key one level down. So the chokepoint walks the schema at
registration time and applies strictness at every depth, rather than trusting each tool author to
remember. That converts "unknown arguments are a refusal" from a convention the next tool eventually
forgets into a property of the chokepoint. The doc comment enumerates which schema shapes the
recursion does *not* cover, because an unenumerated gap in a security control is worse than a
documented one.

**Why this option won here.** The chokepoint was built before the first tool exists, which looks like
dead weight and is, until a tool is wired. The alternative is designing authorization alongside the
first tool, under the delivery pressure of shipping that tool's actual functionality — which is
precisely how permission checks end up bolted on late. Building it first means refusal is the default
a future caller inherits rather than a control someone has to remember to add.

The justification for doing this deterministically and server-side is not abstract in this repository:
it is the attribute-breakout bug in entry 002. A defense that depends on correctly escaping untrusted
input into a delimiter-based format is one crafted input away from breaking, no matter how careful the
escaping. Removing the delimiter position is structural. A tool-access decision the model cannot pass
arguments into does not have that failure mode at all, because there is nothing to escape out of.

**How it was validated.** Every refusal path asserted directly rather than inferred from the absence
of a thrown exception, including both authz-denial shapes and the hook throwing a non-`Error` value.
More usefully, a mutation pass: bypassing the unregistered-tool refusal turned the security test red —
and it failed at the *next* gate down, which is defense in depth behaving as designed.

That pass also produced its own correction, which is the more honest lesson. Because the only
chokepoint test at the time called an unregistered tool, the registry gate refused it before the
authorization hook ever ran — so the deny-all hook's own decision method was never actually exercised,
and the hook is not a service, so the coverage threshold could not catch the gap either. "Exercised by
the security suite" was true of the chokepoint and false of the binding. The suite now registers and
allowlists a tool first, so the real default binding's refusal is exercised directly. A coverage
configuration scoped to one file naming convention is a coverage claim about that convention, not
about the system.

**Interview framing.** "The interesting decision is the order of the four gates: access is decided on
tool identity and step context before the arguments are parsed, because parsing is work on an
attacker-controlled payload and none of it should happen before the call is known to be allowed. The
second is that the authorization hook is synchronous and injected once through DI rather than passed
per call — a per-call hook is a bypass vector, since the one caller who passes a permissive stub
reopens the gate invisibly. Default binding denies everything, because 'allow until a policy shows up'
is the default nobody chooses and everybody inherits. And the argument schema is made strict
recursively at registration, since zod's strict only applies one level deep and silently strips
unknown keys below that — which would have made 'unknown arguments are refused' a convention rather
than a guarantee."

---

## 006 — The determinism boundary in durable execution

**ADR:** [0003](./adr/0003-temporal-from-day-one.md) · **Code:** `src/workflows/`, `src/worker/`

**The concept.** A durable execution engine does not persist your workflow's variables. It persists
an *event history* — the sequence of commands the workflow issued and the results that came back —
and it reconstructs live state by re-executing the workflow function from the top, feeding recorded
results back in place of the calls that produced them. That is replay, and it is the whole mechanism.

It has one uncompromising consequence: workflow code must be a pure function of its event history.
Given the same history, it must issue the same commands in the same order. Read the clock, generate a
random number, iterate a collection with unstable ordering, or make a network call, and the replayed
execution diverges from the recorded one; the engine detects the mismatch and fails the task. This is
why the SDK runs workflow code in an isolate with no platform APIs and replaces the clock, randomness
and timers with deterministic shims.

So a model call — the canonical non-deterministic operation, non-deterministic even at temperature
zero across model versions — can never live in workflow code. It lives in an *activity*. An activity's
**result** is what gets recorded in the history; on replay, the recorded result is returned rather
than the call being made again. The boundary is not a purity aesthetic. It is what makes resumption
possible at all: a workflow killed after an expensive model call and restarted does not pay for that
call twice, because replay hands it the recorded answer and continues from where it stopped.

Stated as a design rule: **deterministic orchestration is separated from probabilistic reasoning.**
Workflow code decides what happens next; everything that touches a model, a database or a network
lives on the other side of the line. It is the same "propose versus dispose" split as entries 004 and
005, expressed in the execution model.

**The architectural trade-off.** The alternatives are real. In-process `async/await` behind an HTTP
request is simple and correct right up to the moment the process restarts mid-answer, at which point
the work is gone and there is no record of how far it got. A queue plus a hand-rolled state machine is
durable and uses infrastructure you already run — but the parts being hand-written are durable state,
retry policy, resumption after restart, and waiting indefinitely for an external signal, which are
exactly the parts that are subtly wrong in ways that do not show up under test. The cost of the engine
is a second process to deploy, a local prerequisite beyond `npm install`, and genuine conceptual
overhead: the determinism boundary is easy to violate by accident.

The requirement that settled it is a human approval gate that may take hours or days. In the queue
design that is a polling loop over a status column; in the engine it is a wait on a condition plus a
signal, with the process free to restart underneath it.

**What actually enforces the fence — and what merely signals.** A lint rule forbidding framework,
ORM and provider imports inside the workflow directory fails in CI in seconds and names the offending
file, which is real value. It is not the guarantee. It sees the imports you wrote; it cannot see a
Node builtin reached transitively through a third-party package three levels down. The workflow
bundler *can*, because it performs a total analysis over what actually ships into the isolate, and it
fails loudly at bundle time. Both are kept, with honest roles — but presenting the fast signal as the
guarantee is how you end up trusting a fence that is not there.

The general distinction is worth carrying: a linter is a heuristic over source you authored; a
compiler or bundler is a total analysis over what will actually run. When a rule is load-bearing for
correctness, it belongs to the second category, and a rule in the first category is a convenience that
tells you sooner.

The boundary is maintained in the type system too. Workflow code imports the activity interface as a
*type only*, so the import is erased at compile time. Switching that one import to a value import
would pull the entire service graph into the workflow bundle — which is exactly the violation the
bundler exists to reject, and a good illustration that the fence has a specific, small hole an
ordinary refactor could open.

**At-least-once execution is a cost model, not a footnote.** Activity execution is at-least-once: a
worker crash in the window between an activity succeeding and its completion being recorded re-runs
it. For a paid, non-idempotent model call, that is a duplicate charge. The design response is that
retry policy is set per activity from cost and idempotency, not globally:

- Retrieval — a database read plus a cheap embedding call, idempotent, fast to fail — gets generous
  attempts and a short overall budget.
- Synthesis — paid, non-idempotent, slow — gets a low attempt cap and a timeout budget sized to real
  model latency rather than database latency.
- Persistence — fast, but non-idempotent for the same structural reason (a re-run after a crash writes
  a second record for one run) — gets the low attempt cap with the fast timeout.

The timeouts are split deliberately, and the distinction is the transferable part: one timeout bounds
a *single attempt*, so a hung call is cut off and retried, while another bounds the *entire lifecycle
including retries*, so total exposure is capped. Setting only the second means a hung call consumes the
whole budget in one attempt; setting only the first means retries can extend indefinitely.
Non-retryable error classes are declared so a bad prompt is never retried — retrying a 4xx is paying
twice for the same rejection.

**How it was validated.** A deliberately-added forbidden import, to see the fence reject it, rather
than assuming a rule that has never fired works. The claim worth making about the design — kill the
worker mid-answer, restart it, watch the same answer resume — is a demonstration rather than an
assertion, and that it *is* demonstrable is the reason to have chosen the engine.

**Interview framing.** "Durable execution replays your workflow function against a recorded event
history to rebuild state, so workflow code has to be a pure function of that history — same history,
same commands, same order. That's why every model call, database read and network request lives in an
activity: the activity's result is what's in the history, so on replay you get the recorded answer
instead of paying for the call again. What I'd correct in my own original plan is that I had an ESLint
rule down as the enforcement. It isn't — it can't see a Node builtin pulled in transitively by a
dependency. The workflow bundler is the real gate and the lint rule is a fast signal that names the
file. And because activity execution is at-least-once, retry policy is set per activity from cost and
idempotency: the paid model call gets two attempts, the cheap idempotent read gets five."

---

## 007 — Provenance: content addressing, locators, and versioning the coordinate system

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:**
`src/features/evidence/ingestion/parsers/`, `src/features/evidence/qa/evidence-retrieval.service.ts`

**The concept.** A citation is a claim about *where*, and it is worth exactly as much as its ability
to be resolved — now, and after a re-ingest, a chunking change or a parser upgrade. That makes
extraction a provenance problem rather than a text-extraction problem, and it needs three independent
pieces:

- **A content hash** answers "are these the same bytes?" — content addressing, so a citation pins a
  specific immutable version rather than a mutable document name.
- **A locator** answers "where inside them?" — a structured, format-specific address: a page, a
  paragraph index plus heading path, a spreadsheet cell.
- **An extractor version** answers "in whose coordinate system?" — and this is the one people skip.

The third is the interesting one. A citation carries only its locator. If a parser upgrade shifts page
or paragraph offsets, a citation with no record of which extractor produced its coordinates will still
resolve — to *something*, quietly, possibly the wrong span. There is no error, no exception, no failed
assertion; the highlight simply lands in the wrong place and the answer above it still looks cited. So
the extractor version is stamped on **every locator**, not just on the chunk, because the chunk is not
what travels with the citation. Versioning the coordinate system is what converts a silent
misresolution into a detectable mismatch.

**A design rule that generalizes: parse at the finest addressable unit, then group upward.** Elements
are emitted per page, per paragraph, per cell, and chunking assembles them. The reverse — parse
coarsely and subdivide later — cannot recover a locator that was never captured. The cost is a large
number of elements for a spreadsheet, which chunking has to group sensibly. That is a real cost and
the right one to pay: granularity you did not capture is not recoverable downstream, while
granularity you did capture can always be coarsened.

**Where the pieces are joined matters.** The content hash lives on the document version, not on the
chunk — chunks are numerous and the hash is a property of the source bytes. So retrieval is the one
place that joins a hit back to its version's hash before a citation can be constructed against it. The
consequence shows up in the grounding gate: a citation binds chunk id, version id and hash together,
and all three are checked, so a real chunk id paired with a fabricated version fails. Splitting those
across two records and joining them at exactly one point is what makes that check meaningful rather
than circular.

**"Extracts text from X" is not the requirement.** The plan named a well-regarded DOCX library. It is
an HTML renderer: its raw-text mode discards structure entirely, and its HTML mode exposes no stable
paragraph index and no machine-readable heading path — which is precisely what a paragraph locator
*is*. The library is excellent at its actual job and structurally incapable of the addressability the
citation contract requires, and that is not visible from its README. Reading the document XML directly
and walking paragraphs in document order gives a stable index, and the style ancestry gives the
heading trail.

The general lesson: when a component's output feeds a contract about *addressability* rather than
*content*, evaluate the library against the contract, not against the category. "Extracts text" and
"produces stable addresses into text" are different capabilities that share a description.

**Two more decisions worth carrying.** A percentage-formatted spreadsheet cell stores `0.0525` and
displays `5.25%`; the prose in the accompanying memo says `5.25%`. Conflict detection compares figures
across the two, so emitting the raw fraction would make a genuine agreement look like a conflict. The
parser applies the cell's number format and emits what a reader sees — the extracted representation
has to match the representation the comparison is performed in.

And OOXML is zip plus XML, so both office parsers face XXE, zip bombs and zip-slip. The archive guard
is shared by both rather than duplicated, because the copy that does not get the fix is the one an
attacker finds. Its limit is stated rather than glossed: it reads the sizes the archive *declares*, so
a crafted file can under-report them, and the real bound on decompression is the upload endpoint's cap
on the compressed payload. It is a cheap first filter, not a proof.

**Known limit, stated.** The PDF bounding box is the union of every text item on the page, so it
covers nearly the whole printable area. It is honest as "this page has content" and useless as a UI
highlight. Page-level citation is the real contract today; a usable highlight needs finer locator
granularity than one element per page. Naming that is more useful than a demo that highlights a whole
page and calls it precision.

**Interview framing.** "A citation is only worth something if it resolves, and keeps resolving after a
parser upgrade. That takes three things: a content hash so it pins immutable bytes, a structured
locator so it pins a place, and an extractor version so it pins the coordinate system — and the
version goes on the locator, not the chunk, because the locator is what travels with the citation.
Without it, a parser change that shifts offsets doesn't break anything, it just resolves to the wrong
span silently, which is the worst possible failure mode for a provenance claim. I'd also flag that I
rejected the obvious DOCX library: it extracts text beautifully and exposes no stable paragraph index,
and a paragraph index is literally what the locator is. Evaluating it against 'extracts text from
DOCX' rather than against the contract would have cost me the whole citation model."

---

## 008 — Ground truth is code, and an eval you never watched fail is not an eval

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md) · **Code:** `eval/`,
`fixtures/`

**The concept.** An evaluation dataset is a program artifact with its own correctness problem, and it
is the one artifact in an AI system that nothing downstream can check. Every metric you compute is
conditional on it. If the ground truth is wrong, a correct system scores badly, an incorrect system
may score well, and there is no signal anywhere in the pipeline that tells you which world you are in.
Treating the dataset as data — something you write down and trust — rather than as code, with its own
tests against the artifacts it describes, is the mistake this entry is about.

**The failure that taught it.** Fixtures here are generated deterministically, and the eval dataset
keys its expectations to locators in a manifest the generator produces. The generator wrote each
page's footer inside the bottom margin. The PDF library treats writing below the margin as content
overflow and starts a new page — so every footer landed alone on a page of its own. The memo had
**eight** physical pages, with content on 1, 3, 5 and 7, while the manifest recorded **four**. The
seeded conflict sat on physical page 3 and was recorded as page 2.

Nothing failed. Generation succeeded. The manifest was internally self-consistent. The dataset
validated against the manifest. The suite was green — and every PDF citation in the ground truth
pointed at a blank page. Retrieval would have looked fine while the grounding gate rejected correct
answers, and the metric would have said the model was hallucinating.

**Two holes, both instructive.**

*The generator's guard counted intent, not output.* It counted calls to the footer function — four —
rather than pages actually rendered — eight. This is a general class: a guard that measures the thing
you asked for rather than the thing that happened cannot detect a component doing something other than
what you asked. Counting emitted page events instead closed it. (With a small deterministic wrinkle
worth noting: the library creates its first page inside the constructor, before any listener can
attach, so automatic first-page creation is disabled and every page is added explicitly — rather than
compensating with an off-by-one, which would have hidden the same class of bug again.)

*The dataset test asserted a locator existed in the manifest, not that it was true.* Two derived
artifacts agreeing with each other is not evidence about the thing they were derived from. The
manifest and the dataset agreed perfectly and were both wrong about the file. A locator has to be
checked against the *document it points into*, using the same parsers ingestion uses, not against the
record that claims what the document contains.

**The structural gap underneath it.** Closing the bug properly required more than a fix. The dataset
had no ground-truth *answer* — only locators and an expected outcome — so even a perfectly correct
locator check could not have caught a wrong answer. The harness could have scored retrieval and
abstention and never correctness, which is a limitation you can operate under for months without
noticing, because the numbers it does produce look like eval numbers. Cases now carry expected answer
content, and a resolver parses the real fixtures with the production parsers to check it.

**A verification never observed failing is not yet a verification.** This is the habit I would keep
from the whole project. When a new assertion passes on the first run, the passing tells you nothing —
you have not distinguished "the property holds" from "the assertion cannot fail". So each new check
was deliberately made to fail before being trusted: a specific cell resolves to exactly its own value
rather than the whole sheet; a fabricated needle is genuinely not found; a figure present on page 2 is
found there and *not* on page 1, proving resolution is page-scoped rather than a document-wide search
that would pass regardless of the locator.

The same instinct shows up elsewhere in this log and it is the same instinct each time: the go/no-go
retrieval probe in entry 001 was built to reject both wrong answers, because a false no-go and a false
go are different bugs and a smoke test that cannot tell them apart is not evidence. The fence tests in
entry 002 and the chokepoint test in entry 005 were each mutated until they went red. Designing for
falsification is the difference between a test suite and a green light.

**Interview framing.** "The most instructive bug in the project wasn't in the parser or the model — it
was in the ground truth. My fixture generator was silently emitting a blank page after every content
page, so the manifest said page 2 and the file said page 3, and everything was green, because the
generator's guard counted footer calls instead of rendered pages and the dataset test only checked
that a locator existed in the manifest rather than that it pointed at the right text. Two derived
artifacts agreeing with each other isn't evidence about the artifact they came from. Ground truth is
code — if it isn't tested against the thing it describes, it's a confident assertion, and every metric
you compute downstream inherits that confidence."
