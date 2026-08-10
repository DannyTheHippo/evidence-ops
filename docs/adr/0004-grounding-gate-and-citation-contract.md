# ADR-0004 — The grounding gate: a citation verifier, not a reasoning verifier

- **Status:** Accepted — implemented and unit-tested; known bounds below are current, not
  hypothetical
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

`SynthesisService` returns exactly what the model produced: a discriminated `AnswerContract`
(`answered` / `insufficient_evidence` / `conflicting_evidence`), schema-validated but otherwise
untrusted. "The model proposes, the application disposes" means something has to check a model's
citations against the actual retrieved bytes before an `answered` outcome reaches a user as
trustworthy. That something is `GroundingGateService` plus its per-claim worker, `verifyClaim`.

## Decision

Three checks, run in order, per citation, with a single fail-closed rule: **one failing citation
drops the whole claim** — a model that pads one fabricated citation onto an otherwise-grounded claim
gets no partial credit.

1. **Retrieval containment.** The cited `chunkId` must be among the chunks actually retrieved for
   this request, and its `docVersionId`/`sha256` must match the retrieved chunk's — a real chunk id
   paired with a fabricated document version is still an unverifiable provenance claim.
2. **Quote containment** (`locate-quote.ts`). The citation's `quote` must appear in the cited
   chunk's text under normalization (`normalize-quote-text.ts` — whitespace/smart-quote/line-break
   tolerant). Exact normalized containment is the only passing outcome.
3. **Numeric-claim support** (`extract-numeric-tokens.ts`). Every number in the claim's statement
   must be supported — either by a cell-level `ExtractedFact` on a cited chunk (upgrades the
   citation's locator, since a cell fact is strictly stronger evidence than a whole-region quote
   match) or by the cited chunk's text containing the same number.

Claim-level survival then degrades to an outcome via `GroundingGateService.verify`: every claim
survives → `answered` at full coverage; some survive → `answered` at reduced coverage with drops
recorded; none survive → `insufficient_evidence` (a valid, correct state, not an error); any
surviving claim touches a fact key present in `conflictedFactKeys` → `conflicting_evidence`,
overriding every other outcome — a well-cited answer that quietly picks one side of a known
disagreement is the exact failure this override exists to prevent.

## Known bounds

These are current properties of the shipped gate, not aspirational gaps — recorded here because an
interview answer that omits them is a sales pitch, not an ADR.

1. **Citation verifier, not reasoning verifier.** The gate checks that a quote is really present in
   a cited chunk and that a claimed number is really supported. It has no opinion on whether the
   claim's *reasoning* from that evidence to that conclusion is sound. A correctly-cited but
   wrongly-reasoned claim passes.

   **Worked example** (`test/security/canary.spec.ts`, "grounding gate — known bound"): the
   market-overview PDF canary is a prompt-injection sentence physically embedded in a retrieved
   chunk's text. A claim whose statement echoes the canary's marker token, citing that exact
   sentence as its quote, **survives** verification — checks 1 and 2 both pass, because the
   injected sentence genuinely is present in the chunk (that is the entire attack). The gate cannot
   distinguish "the model quoted real evidence" from "the model quoted an instruction embedded in
   real evidence" — both are, truthfully, quotes of the chunk's actual text. This is why
   `test/security/canary.spec.ts`'s "never leaks" assertion is scoped to a model that follows the
   system prompt's instruction to treat fenced content as data, not to a model that has been
   successfully turned by it — the gate was never meant to be, and cannot be, a content filter.

2. **Numeric support is digit-pattern matching, not comprehension.** `extractNumericTokens` matches
   `\$?\d[\d,]*(?:\.\d+)?%?` — a number written in words ("six percent") is invisible to it, and a
   scaled value written as `"$41 million"` parses as the number `41`, not `41,000,000` (the pattern
   has no notion of a trailing magnitude word). A claim citing `"$41 million"` against evidence that
   also happens to contain a bare `41` anywhere would be judged supported for the wrong reason.

3. **Conflict-forcing is chunk-scoped and errs toward over-triggering.** A claim is forced to
   `conflicting_evidence` if any cited chunk carries a cell fact whose key matches a known
   conflicted fact key — regardless of whether the claim's specific citations actually touch the
   conflicting value, or merely share a chunk with it. The chosen direction is deliberate: a false
   `conflicting_evidence` costs a follow-up question; a false `answered` that silently picks a side
   of a real disagreement costs trust in every subsequent answer.

4. **Only the `answered` branch is verified.** `insufficient_evidence.reason` and the entirety of
   `conflicting_evidence` (its `factKey`, its `values` array) are model-authored text and numbers
   that reach the caller with **no deterministic check at all** — there is nothing in either branch
   shaped like a citation for this gate to verify against. A model could write a fabricated
   `conflicting_evidence.values` entry today and nothing catches it before persistence.

5. **`conflictedFactKeys` is never supplied in the wired path.** `src/worker/activities.ts`'s
   `groundingCheck` calls `GroundingGateService.verify` without a `conflictedFactKeys` argument —
   `ConflictsService` isn't wired into this activity (out of scope for this change). `verify`'s
   forced `conflicting_evidence` override (see the Decision section above) can therefore never
   actually fire on the path a real request takes; today it is reachable only from
   `grounding-gate.service.spec.ts` calling `verify` directly. `groundingCheck` still has an
   explicit unreachable-branch guard for it (throws rather than silently mis-persisting), because
   the report's type still allows it and a future caller could supply the argument without also
   updating that guard.

6. **No fuzzy acceptance on quote matching.** `locate-quote.ts` computes a similarity score via
   bounded edit distance purely to *label* a near-miss as `'fuzzy'` (worth surfacing to a human or
   an eval) rather than `'none'` (no real relationship to the chunk) — but both are rejections.
   `FUZZY_SIMILARITY_THRESHOLD` is diagnostic-only; no similarity value, however close to 1, is ever
   treated as verified. The reasoning is stated in that file: accepting a near-miss as verified is
   exactly how paraphrase and fabrication leak through a citation checker — the entire value of
   requiring a *verbatim*, normalized-substring match is that a model cannot get credit for a
   citation that merely sounds right.

## Consequences

**Good.** Every `answered` claim's citations are checked against bytes actually retrieved for the
request, not against the database at large — a model cannot cite a real document it was never shown.
Fabricated provenance (real chunk id, wrong document version), fabricated quotes, and unsupported
numbers are all dropped at claim granularity, and every drop is logged with its reason.

**Costs.** Five deterministic checks (three per-claim, two outcome-level) is more surface than a
single boolean "did the model cite something", and each one needed its own bound stated rather than
assumed away.

**Deferred, deliberately.** Verifying `insufficient_evidence`/`conflicting_evidence` content, and
teaching the numeric check to parse magnitude words, are both real next increments — not designed
here because neither has a forcing example yet the way the canary fixture forced the citation-vs-
reasoning bound above.

## Interview framing

> The gate verifies citations, not reasoning, and I have a fixture that proves it: a canary sentence
> embedded in a real document, which a model can quote verbatim and pass every check while doing so,
> because the check is "is this text really in the chunk" and the answer is genuinely yes. I didn't
> want to claim more than that in the ADR. The second thing I'd flag myself: the gate only verifies
> the `answered` branch. `insufficient_evidence` and `conflicting_evidence` currently reach a caller
> on model say-so alone — that's a known, not a hidden, gap.
