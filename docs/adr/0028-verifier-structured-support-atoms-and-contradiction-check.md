# ADR-0028 — Verifier: structured support, monotone atoms, and a lowering-only contradiction check

- **Status:** Pre-registered — the mechanisms below are implemented and unit-tested
  (`verify-structured-support.ts`, `verify-atoms.ts`, `contradiction-check.service.ts`, and their
  specs); the measurement run this record's bars are set against has not happened yet. The
  `## Result` section is a placeholder, appended once it has.
- **Date:** 2026-09-07
- **Supersedes:** —
- **Amends:** `docs/adr/0024-what-the-first-measurements-say.md` § Consequences — the "`verify_claims`
  must not be described as working" verdict was recorded against the digit-string-matching, no-atom,
  no-contradiction-check verifier; this record measures whether the mechanisms below change that
  verdict, on the same corpus. `docs/adr/0020-attestation-surface.md` — the 8.5-minute
  `answerQuestion` worst-case activity budget grows by two more sequential activities
  (`decomposeClaims`, `checkContradictions`) that ADR-0020 did not account for.

## Context

ADR-0024 measured the verifier this record replaces the core of. Against 108 claims drafted from
this project's own nine-file synthetic corpus, **zero of sixty claims drafted from a tabular
source grounded** — not a rate, a wall. Of the twenty sampled failures three independent
adjudicators (one neutral, one briefed to find the gate correct, one briefed to find it wrong)
returned the identical partition, **5 correct catches, 15 false catches — 25% against a 70% bar**.
Fifteen of fifteen false catches trace to one shape: `citations the gate accepted: none` on a claim
that verbatim-restates a spreadsheet row. `verifyClaim`'s check 4 treated a cited chunk carrying any
cell fact as authoritative for numbers and had no way to bind a claim's stated number to a specific
measure, entity, or period — only to a bare digit run.

ADR-0024's own end-to-end trace names the mechanism for one family of that failure. Claim `c001`
restates a `comps.xlsx` row — sale date, price, price per square foot, cap rate, net operating
income — every figure of which is extracted as a cell fact on the rank-1 retrieved chunk, and was
refused as `numeric-claim-unsupported`. `extractNumericTokens` over the claim's statement produced
`[2025, 7, 15, 46900000, 269.34, 4.55, 2134450]`; the chunk's fact amounts included `46900000,
269.34, 4.55, 2134450, ...` but not `2025`, `7`, or `15` — **a date is decomposed into three
integers, and a date component is not a fact amount.** Because the chunk carries cell facts, the
numeric check's raw-text fallback is disabled entirely, so the digits `2025`/`7`/`15` sitting in
plain sight in the chunk's own text were never consulted either. 23 of the 27
`numeric-claim-unsupported` failures in that run stated a date, against 6–8% in every other failure
class.

ADR-0020's Known bounds 2 and 3 name the two structural gaps in the deterministic gate that no
digit-matching fix touches. Bound 2: `checkQuoteAlignment` is lexical token overlap, not semantic —
negation, sarcasm, and any other meaning-reversing construction that preserves shared vocabulary
defeats it. Bound 3: nothing deterministic checks that a cited quote set *covers* a statement, only
that it *overlaps* one — a claim joining a true, fully-quoted assertion to a false rider grades
exactly like a fully-supported claim, because nothing before the model's own judgment (`buildSystemPrompt`
in `assemble-verify-claim-messages.ts`) ever asks whether an excerpt states the claim rather than
merely mentioning it. Neither bound is closed here. The three mechanisms below target the tabular
0%-grounded wall and the false-catch share it produced, not the lexical-vs-semantic ceiling ADR-0020
already named and left open.

## Decision

### Structured-fact matching replaces digit-string matching; entity binding is not optional once measures are supplied

`verify-structured-support.ts` binds a claim's stated numbers to a confirmed measure, a cell fact's
own canonical value (unit-converted, tolerance-compared), and — when the claim states one — a
matching period, rather than to raw digit equality. Six rules, each independently tested: R1
(`findBoundFact`) binds a number to the first cited, entity-bound, metric-candidate,
period-compatible cell fact whose canonical value matches within the measure's own tolerance; R2
(`candidateMeasuresFor`) decides which measures a number can bind to at all (see Known bound 1
below — this is where the loosest rule in this change lives); R3 (`canonicalFactAmount`,
`candidateCanonicalValues`, `withinTolerance`) handles unit conversion and the bare-number
percentage dual reading; R4 (`numberSupportedByRawText`) is the asymmetric fallback (next
subsection); R5 (`isPeriodSupported`) supports a stated period the same two ways R4 supports a
number; R6 drops a claim outright on an unrepresentable digit run, independent of whether every
other number in it binds.

Entity binding is structural, not a caller opt-in, once `measures` is supplied to `verifyClaim`.
`verifyStatement` in `verify-claim.ts` derives `structuredSubjectEntities` — the union of
`collectSubjectEntities` (cell-fact entities the statement names by whole-token match) and
`assertions.entityMentions` (canonical-entity aliases `parseClaimAssertions` recognized) —
**independent of the separate `subjectBinding` flag**, which only gates the legacy digit-matching
branch. R1, R4, and R5 all consult this set: a chunk that never names the claim's own subject
supports nothing under the structured path, whether or not `subjectBinding` itself is on.

### The fallback rule, and the evidence it rests on

A number that binds to no fact (R1 fails) is checked against a cited chunk's raw text by
`numberSupportedByRawText` (R4) — but only when that chunk carries **no** cell facts at all. Once a
chunk has even one cell fact, a measure-bound number never falls back to raw text on that chunk,
cell-fact chunk or otherwise; an *unbound* number (no candidate measure at all — R2 found none) may
still match raw text anywhere. `verify-claim.ts`'s own check 4 states the same asymmetry for its
legacy digit-matching path: "a cited chunk that carries any cell fact is authoritative for numbers:
an unmatched value there is rejected outright, never accepted on a coincidental digit substring
elsewhere in that chunk's raw text." ADR-0004 bound 2 is the record of why — a structured extraction
is ground truth for its own chunk, and a chunk's raw text routinely repeats unrelated digits across
rows and columns a coincidental substring match cannot distinguish from a real one.

### Monotone atoms, with the lazy-decomposition exit visible as a counter

`verify-atoms.ts`'s `verifyAtoms` always verifies the whole claim statement first
(`verifyStatement`), and only checks decomposed atoms individually when the whole statement already
survived *and* `checkAtomCoverage` finds the atom set covers the statement in both directions —
every content token the statement asserts appears in some atom, and no atom introduces a content
token the statement itself does not assert. This ordering is what makes decomposition unable to
launder a claim through: an omitted false rider can never turn a claim the whole-statement check
already dropped into a survivor, because the whole-statement check runs first and has already
dropped it on its own account.

An incomplete decomposition — coverage fails either direction — falls back to the whole-claim result
unchanged, never to a looser per-atom check, and is counted as `coverageFallback: true`. That
counter is `GroundingReport.atomization.coverageFallbackCount`, and it is the exit this mechanism
takes whenever a model's decomposition cannot be trusted to have faithfully split the claim: it is
the measured signal for how often atom-level checking silently reverts to whole-claim checking (see
Known bound 2 — it is measured, but nothing downstream reads it yet).

### The contradiction check: a lowering-only, model-authored veto behind a flag defaulted off

`ContradictionCheckService.check` is a veto-only gate applied only to a claim that has already
survived every deterministic check. Its entire output alphabet is one boolean
(`contradictionCheckContractSchema`), which is what makes it structurally incapable of authoring a
verdict of its own: it can only lower a verdict this codebase already computed
(`reasonCode: 'claim-contradicted'` in `ClaimVerificationService.verifyOneClaim`, or dropping into
`contradictedClaimIndexes` in `src/worker/activities.ts`'s `checkContradictions` activity on the
answer-synthesis path), never raise one. It also fails OPEN on its own call: a provider throw, spend
refusal, schema-validation exhaustion, or timeout is caught and returned as `{ kind: 'unavailable' }`,
which changes nothing about the claim under check — a veto-only gate whose measurement is broken
must never block the thing it measures.

The check is gated behind `config.verifier.contradictionCheck`
(`VERIFY_CONTRADICTION_CHECK` — `environment.config.ts`, `docker-compose.yml`), **default `false` in
both places**. With the flag off, no code path constructs a contradiction prompt: both call sites —
`ClaimVerificationService.verifyOneClaim` (`if (this.config.verifier.contradictionCheck) { ... }`)
and `activities.ts`'s `checkContradictions` activity (`if (!config.verifier.contradictionCheck) return
{ contradictedClaimIndexes: [] }`) return before `ContradictionCheckService.check` is ever reached,
issuing no model call and resolving no citation. This is pinned, not merely stated:
`claim-verification.service.spec.ts` ("should never call ContradictionCheckService when
contradictionCheck is disabled, matching a run whose stub would flip the verdict if invoked") and
`activities.spec.ts` ("should return no contradicted claims and never call
ContradictionCheckService.check when the flag is off") both stub `check` to throw if it is called at
all, with the flag off, and assert it was never called.

## Two-step enable

**Step 1 is this commit.** The mechanism ships with `VERIFY_CONTRADICTION_CHECK` defaulted `false`
everywhere it is read, behavior is byte-identical to before this change with the flag off, and both
inertness tests above pin that.

**Step 2 is a config-only edit**: flipping `docker-compose.yml`'s
`VERIFY_CONTRADICTION_CHECK: ${VERIFY_CONTRADICTION_CHECK:-false}` default to `true`. No code change.

WATCH: contradictionDropRate on the synthetic lane and the verifier experiment's false-catch share after enable; roll back the default if false catches rise or drop rate exceeds 10% of claims.

## Pre-registration

Written before the measurement run (steps 2.18–2.21), so the bars below cannot be adjusted to fit
the result.

- **Bar 1 (repeat of ADR-0024):** at least 20% of drafted claims fail the gate.
- **Bar 2 (repeat of ADR-0024):** at least 70% of adjudicated failures are correct catches, not the
  gate's own retrieval or binding failing.
- **Sampling:** failures sampled with seed `1729`, capped at 20 sampled failures — the same cap
  ADR-0024 used.
- **Adjudication:** three independent adjudicators per sampled failure — one neutral, one briefed to
  find the gate correct, one briefed to find it wrong — the identical method ADR-0024 used, so a
  result here is comparable to that record's rather than being a differently-shaped measurement.
- **Reported, not gated:** the result is split by source (tabular vs. prose), the same split
  ADR-0024 reported, so a reader can see whether the tabular wall specifically moved rather than only
  an aggregate rate.

## Metric direction: why the two drop rates are reported-only, never gated

`coverageDropRate` (Σ `atomDroppedClaimCount` / Σ claims) and `contradictionDropRate` (Σ
`contradictionDroppedClaimCount` / Σ claims) are both in `eval/metrics/compute-metrics.ts`'s
`EvalMetrics`, and both are deliberately absent from `compare-baseline.ts`'s `GATED_METRICS`. On a
frozen replay corpus that never changes, a lower drop rate reads as "the verifier is working better"
only if something independently forces the checker to keep checking; nothing does. A checker that
stops dropping anything — atoms it should reject, contradictions it should catch — would show the
same falling rate a genuinely improved checker would, and gating the metric would reward exactly
that failure mode instead of the improvement it is meant to detect. `tabularGroundedRate`, by
contrast, is gated (`higher` direction): it can only rise by grounding more tabular claims that
really are supported, never by refusing to check anything, so gating it carries no equivalent risk.

## Known bounds

- **Per-atom alignment over-rejection.** `verifyAtoms` runs `checkQuoteAlignment` again for each
  atom, via the same `verifyStatement` the whole claim used. An atom is typically much shorter than
  the claim it was split from, and `checkQuoteAlignment`'s proportional floor
  (`SHARED_CONTENT_TOKEN_RATIO`, ADR-0022) scales with the *statement's own* word count — so a short,
  faithful atom can share fewer tokens with a long cited quote than the whole claim did, and fail
  alignment the whole-claim check would have passed. This is fail-closed (an atom that should have
  survived is dropped, never the reverse), but it is a real source of over-rejection this change does
  not measure separately from a genuine unsupported atom.
- **`parseClaimAssertions`'s unit vocabulary is closed and English-only.** Currency needs a `$` sign
  or a preceding `usd`; percentage needs a `%` sign, `percent`/`pct`, or `bps`/`basis points`; area
  needs `sf`/`rsf`/`sq ft`/`square feet`/`square foot`; duration needs `year`/`years`/`yr` or
  `month`/`months`; magnitude scaling recognizes `k`/`thousand`/`m`/`mm`/`million`/`bn`/`billion`. A
  number qualified any other way — a unit word this vocabulary does not recognize, a non-English
  unit — reads as `unitKind: 'unknown'`, the same bare-quantity treatment as a number with no unit at
  all.
- **The bare-number percentage rule reads a plain number two ways at once.** `candidateCanonicalValues`
  compares a bare, unit-less number (`unitKind: 'unknown'`) against a percentage-typed candidate
  measure at both its literal value and that value scaled by `0.01` — "the cap rate is 4.55" matches a
  `0.0455`-canonical fact without a `%` sign ever appearing. This is deliberate (§ Decision above
  references it under R3), but it means a bare number can bind to a percentage fact under a reading
  the claim's own text never stated explicitly.
- **`entities` is required for alias-based binding; its absence narrows to token-overlap only.**
  `parseClaimAssertions`'s `entityMentions` is only populated from the `entities` list `verifyClaim`'s
  caller passes; when `measures` is supplied without `entities` (or with an empty list), a claim
  naming an entity only by alias — not by the exact string a cell fact's `factKey.entity` carries —
  contributes nothing to `entityMentions`, and structured subject binding falls back to
  `collectSubjectEntities`'s whole-token match against the cell facts' own entity strings.
- **`Answer.usage` is synthesis-only; decomposition and contradiction-check spend are not reflected in
  it.** `answer-question.workflow.ts` threads only `synthesizeAnswer`'s `usage` through to
  `persistAnswer` — the model calls `decomposeClaims` and `checkContradictions` make (both real spend
  when they run) are never summed into the value persisted on `Answer.usage`. `ClaimVerificationService`
  does not have this gap on its own call path: `verifyClaims` sums usage across every model call
  (verification, decomposition, contradiction check) into the one `VerificationsService.record` row it
  persists per call.

### The R2 candidate bound

A typed number's candidate measures (`candidateMeasuresFor`, `verify-structured-support.ts`) are
**every confirmed measure of the matching `valueType`** — mentions in the statement are ignored
entirely for a typed (currency/percentage/area/duration) number; only an `unknown`-typed bare number
is narrowed to measures the statement actually names. A claim naming one measure can therefore bind
to a *different* same-type measure's fact, at the same entity and period: "NOI was $46,900,000" can
bind to a `sale_price` fact of `46,900,000`, because `net_operating_income` and `sale_price` are both
`valueType: 'currency'` in `metric-ontology.ts`, and R2 offers both as candidates regardless of which
one the sentence names.

This is a deliberate looseness, taken because the tighter, "mentioned-and-compatible-first" rule
cannot ground ADR-0024's own `c001` sentence. That claim restates a comps row's sale price and price
per square foot without ever using either metric's recognized alias phrasing — `sale_price`'s
aliases are "Sale Price (USD)", "sale price", "purchase price", "contract price", none of which
matches a sentence phrased around "sold for" — so a rule requiring the statement to *name* the
measure before binding to it would leave those numbers exactly as unbound as the legacy
digit-matching path left them, defeating the reason this mechanism exists.

The residual risk, stated plainly: a number verified this way is confirmed **present in the
structured record for that entity and period**, not confirmed as *that specific measure's* value. Two
same-type measures on the same entity and period with coincidentally close values could still let a
claim bind to the wrong one. This lives entirely in `candidateMeasuresFor`
(`verify-structured-support.ts`) — a future tightening that requires a mention only when more than
one same-type candidate exists for the same entity/period pair would close it without reopening the
`c001` gap, but is not implemented here.

### An unmeasured fail-open path (found 2026-09-07, carry as a WATCH line)

`GroundingReport.atomization` (`AtomizationSummary`, `claim-atoms.type.ts`) carries four counters:
`decomposedClaimCount`, `coverageFallbackCount`, `atomDroppedClaimCount`,
`contradictionDroppedClaimCount`. The eval aggregates exactly two of them into gated-metric-adjacent
figures — `coverageDropRate` sums `atomDroppedClaimCount` over total claims, and
`contradictionDropRate` sums `contradictionDroppedClaimCount` over total claims — both wired exactly
as planned, in `eval/metrics/compute-metrics.ts` and read from `verificationReport.atomization` in
`eval/run.ts`.

**`coverageFallbackCount` reaches no metric.** It is the one counter measuring the fail-open branch:
when `checkAtomCoverage` finds a decomposition too incomplete to trust, `verifyAtoms` reverts to the
whole-claim result and atom-level checking silently does not happen for that claim. Nothing in
`eval/run.ts` or `compute-metrics.ts` reads `coverageFallbackCount` into any reported number, so a
run where every claim's atomization quietly fell back to whole-claim checking prints identically to
one where atom-level checking ran on every eligible claim.

Worth noting separately because it makes the gap easy to read past: the metric named
`coverageDropRate` is **not** sourced from the coverage check at all — it counts atom-level drops
(`atomDroppedClaimCount`), not coverage fallbacks (`coverageFallbackCount`). A reader scanning for
"is the coverage mechanism doing anything" would reasonably look at `coverageDropRate` and find a
number that answers a different question.

**WATCH:** until a metric exists for it, inspect `coverageFallbackCount`'s share of decomposed claims
directly in the eval run's raw `verificationReport.atomization` output (`decomposedClaimCount` is the
denominator) rather than inferring it from `coverageDropRate` or `contradictionDropRate`.

### The sanitization boundary

`ClaimVerificationService.verifyOneClaim` sanitizes once, at the top: `sanitized =
formatPromptLabel(sanitizeEvidenceText(statement))`. Every model-facing string downstream of that
point — the retrieval query, the prompt `assembleVerifyClaimMessages` builds, the text
`ClaimDecompositionService.decompose` receives, and the atom (or `sanitized` itself, when no atoms
exist) `ContradictionCheckService.check` receives — is the sanitized form. The byte-level checks
(`verifyClaim`'s four checks, run via `claimSchema.parse({ statement, citations })`) see the caller's
exact, unsanitized bytes.

The contradiction check's no-atoms fallback stays on the model side of that boundary by construction,
not by a separate guard: `atoms ?? [sanitized]` falls back to `sanitized`, never `statement`, and the
atoms themselves are sanitized already — `ClaimDecompositionService.decompose` is fed `sanitized`, so
whatever it returns inherits that. The identical `?? [sanitizedStatement]` fallback in
`activities.ts`'s `checkContradictions` activity holds the same rule on the answer-synthesis path.
This is the present rule, stated so a future edit to either call site cannot quietly reintroduce a
raw-text path to a model call.

## Result

Measured 2026-09-07, against the bars pre-registered above and not revised after seeing them.

- Run: `b7b2aa29600d554d61ef31b8048df4338e60cc5d-dirty-2026-09-07T10-13-44-162Z`
- Git sha: `b7b2aa29600d554d61ef31b8048df4338e60cc5d-dirty`, tenant `eval`, seed 1729
- Claims drafted: 108 (12 per corpus file, 0 duplicates dropped)

### Verdicts

| Verdict | Count |
| --- | --- |
| grounded | 46 |
| not_grounded | 53 |
| no_evidence_retrieved | 0 |
| conflicting_evidence | 9 |
| gate failures (not_grounded + no_evidence_retrieved) | 53 |

### The two bars

**Bar 1 — MET.** 49.1% of drafted claims failed the gate, against a minimum of 20%.

**Bar 2 — MISSED.** 25.0% of adjudicated failures were correct catches, against a minimum of 70%.
Twenty of the 53 failures were sampled; 5 adjudicated `correct_catch`, 15 `false_catch`, 0 left
unadjudicated.

### Tabular versus prose, against ADR-0024's own split

| Source | Claims | Grounded (ADR-0024) | Grounded (this run) |
| --- | --- | --- | --- |
| Spreadsheet / CSV | 60 | **0** | **18 — 30%** |
| Prose (PDF / DOCX) | 48 | 31 — 65% | 28 — 58% |
| All | 108 | 31 | 46 |

The tabular wall ADR-0024 recorded is gone: zero of sixty became eighteen of sixty, which is the
change structured-fact matching was built to make. Prose grounding fell slightly over the same
change, from 31/48 to 28/48. On the synthetic eval lane the three metrics recorded alongside this
run were `tabularGroundedRate` 0.33, `coverageDropRate` 0.00 and `contradictionDropRate` 0.00 — both
drop rates zero because no atom was dropped and the contradiction check is flagged off.

### Adjudication and agreement

Three independent adjudicators, each on a private copy of the worksheet with read access to the
corpus, briefed neutral, briefed-to-find-the-gate-correct, and briefed-to-find-it-wrong. Per-row
majority merged; a split row takes the majority and its note records the dissent.

| Adjudicator | correct_catch |
| --- | --- |
| neutral | 2 |
| briefed-for | 7 |
| briefed-against | 5 |
| **merged (majority)** | **5** |

Fifteen of twenty rows were unanimous. The five splits were c007, c008, c096 (2-1 to
`correct_catch`) and c040, c099 (2-1 to `false_catch`). Both stance-briefed adjudicators conceded
rows against their own brief, which is the property that makes the merge worth reading: the
briefed-for adjudicator returned 13 `false_catch`, and the briefed-against adjudicator returned 5
`correct_catch` including all three superlative claims.

### What the failure is, mechanically

**Eleven of the fifteen false catches are negation-shaped claims.** They assert that something is
*absent* — "No other properties besides Kestrel Point Logistics Center appear in this CRM export"
(c028), "Kestrel Point Logistics Ctr is the only property listed in this flyer export" (c037), "No
street address, city, or state is provided" (c040), "The extract does not specify the property type"
(c021). In every one of these the adjudicators confirmed by direct file read that the excerpt shown
to the verifying model already *was* the complete file, so the absence is verifiable from the
evidence the gate held in its hand.

The mechanism is structural, not a tuning error. `verifyStructuredSupport` grounds a claim by
binding each number or entity the claim asserts to a fact, or failing that to a matching span of
cited raw text. A claim asserting absence offers nothing to bind: there is no value to look up, and
the raw-text fallback cannot match a string that is by definition not present. Both routes return
"unsupported", and the gate — correctly, given its own rule — drops the claim. The rule it applies
is "I could not find support for this assertion"; the assertion is "there is nothing to find". The
verifier has no way to express the difference, so a true negation and an unsupported positive claim
are indistinguishable to it.

This is a class the mechanism was never designed for rather than a defect within it, and naming it
is the useful outcome of the run: grounding a negation requires checking exhaustiveness over a
retrieved set — that the cited evidence is the *whole* of what exists for that entity — which is a
different operation from binding a value, and one this codebase does not currently perform anywhere.
The remaining four false catches are verbatim or near-verbatim restatements of `lease-summary.docx`
passages shown at rank 1 (c061, c062, c070, c071); those are within the mechanism and are the
tractable part.

### Disposition

**A missed bar is recorded, not adopted.** Bar 2 stands at 25%, unchanged from ADR-0024's 25%
despite the tabular wall being removed — the composition of the failures changed while the
correct-catch share did not. The bar is not lowered, the result is not restated as a partial
success, and `verify_claims` must still not be described as working. What this run licenses is the
narrower claim ADR-0024's § Consequences left open: tabular claims can now ground at all, at 30%.
What it does not license is any claim about the gate's precision, which remains unproven at three
times the distance from its bar.

Follow-up this run identifies, in priority order: (1) decide whether negation claims are in scope at
all — if they are not, the drafting step should stop generating them and the bar should be measured
over the claim classes the mechanism addresses, which is a change to the *measurement*, not to the
bar; (2) trace the four rank-1 verbatim prose misses (c061, c062, c070, c071), which are inside the
mechanism and should be groundable; (3) re-run before enabling the contradiction check, since its
`WATCH` line reads a false-catch share this run puts at 75%.
