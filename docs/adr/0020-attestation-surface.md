# ADR-0020 — An attestation surface: checking another assistant's claims, not just answering our own

- **Status:** Accepted — `ask_evidence` and `verify_claims` implemented (`src/mcp/mcp-tools.ts`,
  `src/features/evidence/qa/claim-verification.service.ts`), a fourth deterministic gate check
  added (`check-quote-alignment.ts`), and a spend gate withholding both spending tools when the
  tenant's daily ceiling is disabled
- **Date:** 2026-08-24
- **Supersedes:** —

## Context

ADR-0014 shipped an MCP surface that let a client's own AI tooling reach this platform's verified
retrieval and answer-lookup capability, but the only way to *get* an answer was to start one and
wait — no non-blocking start, and no way for a caller who already has its own draft text to check
it against the corpus. Two tools close both gaps:

- **`ask_evidence`** starts the gated Temporal answer pipeline and returns `{answerId, runStatus}`
  immediately, without waiting for an answer. `WorkflowEngine` (`src/providers/workflow-engine/
  workflow-engine.interface.ts`) has no result-awaiting method — only `start`, `status`, `signal`
  — and `answerQuestion`'s own activity budget (`src/workflows/answer-question.workflow.ts`) sums
  to roughly 8.5 minutes worst case across its four `scheduleToCloseTimeout`s (retrieval 2 min +
  synthesis 5 min + grounding check 1 min + persist 30 s), too long for a stateless HTTP transport
  to hold open. `get_answer` is the poll.
- **`verify_claims`** lets another AI assistant submit **its own draft claims as plain strings** —
  text this codebase did not write and has no model call behind. The service retrieves evidence per
  claim, has a model pick a supporting candidate from what was retrieved, then runs the same
  deterministic gate `GroundingGateService` runs on this system's own synthesized answers
  (`verify-claim.ts`) and returns a per-claim verdict from a closed set.

That second tool is the differentiator this ADR is really about. Evidence Ops stops competing with
assistants that already answer questions perfectly well on their own, and starts checking them: a
deterministic check that a claim is supported by a span in a specific document version, which
before this change only ever ran on the system's own output (`SynthesisService` → `GroundingGateService`),
now runs on text this system had no hand in producing.

## Decision

### Why a deterministic-only verifier was rejected

The obvious cheaper design skips the model entirely: for each claim, deterministically pick the
retrieved candidate whose text best matches the claim, then run the same three-check gate. It was
rejected because a deterministic proposer's objective function *is* the gate's predicate — "pick
the candidate and span that most looks like it satisfies retrieval containment, quote containment,
and numeric support" is exactly the procedure that walks a false claim through every check.

**Worked example.** The claim "Northgate Business Park is located in Portland," against a corpus
that actually says Seattle. Retrieval returns the Northgate chunk (the claim names the property, so
it is a strong match on its own terms). A deterministic span search over that chunk finds the
literal text "Northgate Business Park, Seattle, WA" as the best-matching span — it shares the most
words with the claim of anything in the chunk. Check 1 (retrieval containment) passes: the chunk was
genuinely retrieved. Check 2 (quote containment) passes: the quote is genuinely present, verbatim.
Check 3 (`checkQuoteAlignment`) passes: the claim and the quote share three content tokens
("northgate," "business," "park") against a floor of two. Check 4 (numeric support) is vacuous —
`extractNumericTokens` finds no digits in "is located in Portland," so there is nothing left to
check, and an empty check trivially passes. The result is `grounded`, for a claim the corpus
actually contradicts. Every non-numeric claim behaves this way: nothing in the deterministic gate
ever asks whether the cited text agrees with the statement, only whether the statement's citations
are genuine — which they are, because a deterministic proposer chose them precisely because they
would be.

### `candidateIndex`, never `chunkId`: structural impossibility over detection

The claim under verification was drafted by another AI assistant, and unlike this system's own
synthesis prompt, that assistant's reasoning is not something this codebase controls or has seen —
it can already be carrying a fabricated `chunkId`, or one lifted from unrelated context, before it
ever reaches `verify_claims`. `modelVerifyClaimContractSchema`
(`src/features/evidence/qa/contracts/verify-claims.contract.ts`) therefore never asks the model for
a `chunkId` at all: `supportedOutcomeSchema` returns a `candidateIndex`, a plain integer into the
`candidates` array `assembleVerifyClaimMessages` built for *this* claim, bounds-checked server-side
in `ClaimVerificationService.verifyOneClaim` (an out-of-range index throws, rather than being
treated as a verdict). An id is a value the model can invent or copy from somewhere else in its
context window; an index into an array the server itself supplied for this one call is neither.

The consequence is worth stating plainly rather than leaving implicit: check 1 in `verify-claim.ts`
(`chunk-not-retrieved`) becomes **vacuous by construction** for every citation this tool resolves —
a `candidateIndex` can only ever name a chunk this call's own retrieval actually returned, so the
citation this tool builds is retrieval-contained before check 1 ever runs. That is the intent, not
an accidental side effect: structural impossibility beats downstream detection. A check that can
never fail is a stronger guarantee than a check that reliably catches the failure, because the first
has no failure mode to miss.

### The verdict vocabulary, and why `supported`/`unsupported` were rejected

`ClaimVerdict` (`verify-claims.contract.ts`) is a closed set: `grounded`, `not_grounded`,
`no_evidence_retrieved`, `conflicting_evidence`. An earlier framing considered `supported` and
`unsupported` as the pair of outcomes and was rejected, because that pairing reads as a truth claim
this system cannot make. There is no falsity check anywhere in this codebase — `GroundingGateService`
and `verifyClaim` verify that a citation's provenance and text are genuine, never that a genuine
citation's content is correct or that its absence means the claim is false. "Unsupported" implies
the system looked for evidence and can vouch that none exists; `not_grounded` and
`no_evidence_retrieved` say only what was actually checked — a citation failed one of the
deterministic checks, or nothing was retrieved to check against at all. `VERIFY_CLAIMS_ADVISORY`
carries the same distinction in prose, attached to every result regardless of its verdicts.

For the same reason, `contradicted_by_corpus` was considered and deliberately omitted from the
vocabulary. No deterministic falsity check exists in this codebase, and building one broader than a
cell-fact numeric mismatch (bound 2, ADR-0004) is a model opinion about whether two pieces of text
disagree — exactly the kind of unverified, model-authored judgment ADR-0004 bound 5 already closed
off for `insufficient_evidence.reason` and `conflicting_evidence`. Adding it here would reopen the
authorship hole this whole design exists to close, on a surface whose entire premise is checking
someone else's authorship rather than trusting it.

### A new bound of its own: verification laundering

ADR-0004 bound 1 and its "known bounds" describe model-authored *text* escaping outward — a claim
that quotes a planted instruction verbatim and passes because the quote is genuinely present. This
tool creates a related but distinct risk: a model-authored *trust label* escaping outward. An
attacker who controls document content already reachable by `search_evidence` can phrase a sentence
so that it clears every deterministic check (the worked example above shows the mechanism even
without an adversarial model, and an adversarial submitting assistant only sharpens it) — and the
`grounded` verdict that results is not model prose an alert reader might discount. It is a single
authoritative-sounding word, produced by a system called Evidence Ops, consumed by another AI
assistant that has every reason to restate it to a human as "Evidence Ops verified this." Zero
authorship on this system's part does not mitigate that risk — the verdict itself is the asset being
laundered, not the sentence it verified.

The mitigations, and what each one closes:

- **Bounded output alphabet.** The model's entire structured output for one claim is a boolean plus
  up to three `{candidateIndex, quote}` pairs (`modelVerifyClaimContractSchema`) — there is no field
  for the model to write a verdict, a confidence, or a rationale into. The verdict is always computed
  server-side, after the schema is parsed.
- **Per-claim retrieval.** Each claim is independently retrieved (`EvidenceRetrievalService.retrieve`,
  called fresh inside `verifyOneClaim`) — one claim's evidence cannot be shaped by another claim's
  content in the same batch.
- **`candidateIndex`, not `chunkId`.** Covered above: the model cannot name a chunk this call did not
  itself retrieve.
- **The model can only lower a verdict, never raise one.** `supported: true` is necessary but never
  sufficient — it only earns the claim a chance to survive `verifyClaim`'s four checks, every one of
  which can still drop it. `supported: false` is dispositive on its own (`not_grounded`), but
  `supported: true` alone never is.
- **Failure direction toward `not_grounded`.** Both branches that determine an unfavorable outcome —
  the model declining to point at evidence, and the deterministic gate dropping a claim — resolve
  directly to `not_grounded`. Nothing in this path can turn ambiguity or partial evidence into
  `grounded`; the asymmetry always favors the weaker, less authoritative label.
- **The fixed advisory string.** `VERIFY_CLAIMS_ADVISORY` is never assembled from claim or chunk
  text — it is the one sentence every `VerifyClaimsResult` carries regardless of its `results`,
  stating plainly that `grounded` means a citation was mechanically checked, not that the claim is
  true. A caller that strips or ignores it is choosing to discard the disclaimer, not tricked into
  omitting one that was never there.

### The honest bound on the new alignment check

`checkQuoteAlignment` (`check-quote-alignment.ts`) is lexical overlap, not entailment. It counts
shared content tokens (or a shared number) between a claim's statement and its cited quotes; it has
no model of meaning and cannot see negation. A claim stating "NOI was strong this quarter," cited
against a chunk reading "NOI was **not** strong this quarter," shares every one of the claim's
content tokens with the quote ("noi," "strong," "quarter" — "was" and "this" are filtered as
stopwords, and "not" contributes nothing the claim itself states) and clears the alignment floor
cleanly, while asserting the opposite of what the source says. This check kills a degenerate
one-word or off-topic quote — the gap that motivated it, per its own doc comment — not a careful,
grammatically-aware attack. It narrows the worked example above; it does not close it, because
nothing before check 4 (still digit-pattern matching, per ADR-0004 bound 2) has any notion of
sentence-level meaning.

### The honest bound on citation coverage: a false rider on a true sentence

The Portland worked example above shows a citation contradicting the whole claim. A subtler shape
survives every check without needing that: a claim that is two assertions joined into one sentence,
where a cited quote genuinely and fully states the first and says nothing at all about the second.
"Northgate Business Park traded in March 2025, and its chief executive was arrested," cited against
a quote that states only the sale, is graded exactly like a fully-supported claim. Check 1
(retrieval containment) passes: the chunk was genuinely retrieved. Check 2 (quote containment)
passes: the quote is genuinely present, verbatim. Check 3 (`checkQuoteAlignment`) passes: the false
rider shares plenty of vocabulary with the true half of the sentence ("Northgate," "Business,"
"Park"), so the claim and the quote clear the content-token floor easily — the check has no way to
attribute overlap to one half of a sentence and not the other. Check 4 (numeric support) is vacuous
the same way it is in the Portland example: the rider carries no digits, so `extractNumericTokens`
has nothing to check. The verdict is `grounded`, for a statement half of which the corpus never
said anything about.

Every check above tests **overlap** — is a quote present, does it share enough vocabulary with the
statement, does it agree on any numbers the statement states — never **coverage**: whether the
quote set, read as a whole, states everything the claim asserts. A statement that is true where it
overlaps a real quote and fabricated where it does not passes exactly the same way a fully-supported
statement does, because nothing deterministic ever asks whether the excerpts, together, account for
the whole sentence rather than merely a piece of it.

The one thing standing between this shape and a `grounded` verdict is not deterministic: it is the
model's own judgment, stated in `buildSystemPrompt` (`assemble-verify-claim-messages.ts`), that a
candidate excerpt must "directly state the claim" and that an excerpt "which merely mentions the
same entity, topic, or numbers as the claim, without actually stating it, is not support." That
framing is why the prompt spends several sentences on when to abstain rather than one — it is not
decorative caution around an already-closed gap, it is the only defense this bound has, and the
model producing that judgment is the same untrusted party every other bound in this ADR already
declines to trust (§ A new bound of its own, above).

`VERIFY_CLAIMS_ADVISORY` does not overclaim against this bound: its text names exactly the two
things a `grounded` verdict mechanically establishes — "the citation and every number in the claim"
— never a claim that the cited quotes cover every non-numeric assertion the statement makes. A
reader who takes its closing line, "this is not a claim of truth — only that the corpus supports
it," to mean the corpus supports the *entire* statement is reading past what the mechanism actually
checked; the verdict cannot distinguish a fully-covered claim from one carrying an uncovered false
rider, because nothing upstream of the verdict draws that distinction either.

### A coupled invariant, not a property of `verify_claims` alone

`verify_claims` is not, by itself, a wider exfiltration channel than this MCP surface already had.
`mcpSearchEvidenceToolDefinition`'s own description states that `search_evidence` already returns
"each matching chunk in full — its complete text" to any caller who clears `MCP_READ_STEP`'s Member
floor, and `MCP_VERIFY_STEP` is floored at the identical `UserRole.Member`
(`step-policy.authz-hook.ts`). A caller who can invoke `verify_claims` could already read the same
chunk text directly through `search_evidence` — `verify_claims` never discloses text `search_evidence`
does not already hand back at the same role floor. This is coupled, not independent: narrowing
`search_evidence` to short snippets in a future change, without re-examining what `verify_claims`
discloses at the same time, would silently make `verify_claims` the widest read channel on this
surface instead of an equally-wide one. Any future change to what `search_evidence` returns needs to
re-check this claim, not assume it still holds.

### No aggregate score, ever

`VerifyClaimsResult` carries `advisory` plus one `VerifyClaimResult` per claim, each independent —
no summary field, no fraction-grounded, no pass/fail rollup, anywhere in the contract, an SDK, or
this document. An aggregate score is the purest form of the laundering risk above: a single number
is even easier to restate uncritically than a single word, and it is the first thing a caller
integrating this tool will ask for. It is withheld on that basis, not omitted by oversight.

### The spend gate covers both `ask_evidence` and `verify_claims`

`McpServerService`'s constructor withholds both tools from `tools/list` and the tool registry when
`config.spend.dailyLimitUsd <= 0` (`SPEND_GATED_TOOL_DEFINITIONS`). Gating only `verify_claims`, the
newer of the two, would have been theatre: `ask_evidence` already reaches paid synthesis
(`SynthesisService`, inside the Temporal workflow it starts) from a long-lived, headless PAT the
moment it is called, and `search_evidence` already reached embedding spend — `EvidenceRetrievalService.
retrieve` calls `EMBEDDING_PROVIDER`, wrapped in `SpendGuardEmbeddingProvider` and reusing the same
`config.spend.dailyLimitUsd` ceiling — before either `ask_evidence` or `verify_claims` existed.
Gating the two model-calling tools at the MCP tool-list level, while `search_evidence`'s embedding
spend is metered independently at the provider layer, is the consistent version of the same posture,
not a partial one.

A stronger fix is deliberately deferred here as cross-cutting, not specific to this change: making
`SpendGuardModelProvider`/`SpendGuardEmbeddingProvider` fail CLOSED with an explicit unlimited
opt-in, rather than the current `dailyLimitUsd <= 0` disabling the ceiling entirely. That is a
platform-wide spend-guard change, not an attestation-surface one.

### No idempotency dedupe on `ask_evidence`

A repeated `ask_evidence` call with the same question starts a second, independent answer — there is
no lookup against a prior identical question before `QaService.startQuestion` runs. This is bounded
by the per-actor rate limiter (`checkRateLimit`, 60 calls/minute by default) and the tenant's daily
spend ceiling, both of which already cap the cost of an unintentional resubmission. A true dedupe
would need a new index and a lookup on every call, for a benefit that is not clearly positive:
repeating a question is sometimes deliberate — corpus content can change between two calls, and a
caller re-asking to get a fresh answer is legitimate use, not a bug to guard against.

`request_resolution` is a useful comparison, not an identical case: it does have a duplicate guard
(`ConflictsService.requestResolution` throws `ConflictResolutionAlreadyPendingException` when a
`Conflict` already has a pending `Approval`), but that guard is scoped to the *conflict*, not the
*request* — it stops two simultaneous proposals for the same conflict from racing, not a
byte-identical resubmission of the same call. Neither tool implements a request-level idempotency
key, and for both, the absence is a deliberate scope decision rather than a gap: `ask_evidence`
relies on rate limiting and spend, `request_resolution` relies on its conflict-scoped pending check,
and a global idempotency-key mechanism was not judged worth the index and lookup cost either would
need.

## Known bounds

1. **Verification laundering is real and only mitigated, not closed.** See § A new bound of its own
   above for the full mechanism and mitigations. The worked example under § Why a deterministic-only
   verifier was rejected demonstrates the underlying gap exists even without an adversarial model —
   it is a property of what the deterministic gate checks, not of any one caller's behavior.
2. **`checkQuoteAlignment` is lexical, not semantic — negation, sarcasm, and any other
   meaning-reversing construction that preserves shared vocabulary defeats it.** See § The honest
   bound on the new alignment check above.
3. **Nothing deterministic checks that cited quotes cover a statement, only that they overlap
   it.** A false assertion joined to a true, fully-quoted one shares enough vocabulary to clear the
   alignment floor and carries no digits for the numeric check to catch, so it grades exactly like a
   fully-supported claim. The only defense is the model's own judgment of whether an excerpt states
   the claim rather than merely mentioning it — the same untrusted party every other bound here
   already declines to trust. See § The honest bound on citation coverage above.
4. **The numeric check's known bounds (ADR-0004 bound 2) apply unchanged here.** A claim stating a
   number in words ("twenty-five years") is invisible to `extractNumericTokens`, and a claim citing a
   chunk with no cell facts inherits the same "$41 million parses as 41" exposure `verify_claims`'s
   citations do, since both call the same `verifyClaim`.
5. **Rate limiting and PAT verification carry the same operational bounds ADR-0014 already
   recorded** (per-process, in-memory rate limiting; two uncached Mongo round-trips per call) — this
   ADR adds two more spend-metered tools behind the identical single-replica assumption, not a new
   bound.

## Consequences

**Good.** A caller with a draft answer already written — its own model's output, another vendor's
answer, a human-drafted summary — gets an independent, mechanically-checked opinion on whether this
tenant's corpus supports each individual claim in it, without that caller ever having to trust this
system's own synthesis path. `ask_evidence` closes the "start a question without blocking a
stateless HTTP request for up to 8.5 minutes" gap ADR-0014 left unaddressed at Accepted status.

**Costs.** A new class of risk this codebase had not previously carried: a trust *label*, not just
model text, can now escape this system's boundary and be restated by another party. The mitigations
above bound it; none of them close it, and closing it further (an aggregate score, a broader
falsity check, a looser verdict vocabulary) was considered and rejected precisely because each of
those "improvements" would widen the laundering surface rather than narrow it.

**Deferred, deliberately.** `SpendGuardModelProvider`/`SpendGuardEmbeddingProvider` failing CLOSED
with an explicit unlimited opt-in (§ The spend gate) is real, cross-cutting, and not designed here.
Whether a future increment ever needs a falsity check narrower than `contradicted_by_corpus`'s
rejected breadth — scoped tightly enough not to reopen the authorship hole — is an open question this
ADR does not answer either way.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the three original deterministic checks
  this tool reuses unmodified, and the bounds (words-shaped numeric gap, citation-not-reasoning
  verifier) that apply to `verify_claims`'s citations exactly as they do to synthesized answers.
- `docs/adr/0014-mcp-server-surface.md` — the MCP surface and chokepoint this ADR's two tools are
  added to; amended alongside this ADR to correct statements about the advertised tool set and the
  Deferred section's account of a question-starting tool.
- `docs/global/threat-model.md` — residual-risk entries for `ask_evidence` and `verify_claims`,
  including the laundering risk and the single-replica deployment precondition both spend-gated
  tools now carry.
