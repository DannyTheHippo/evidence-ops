# ADR-0031 — Public-corpus benchmark: pre-registration

- **Status:** Accepted — pre-registration; results appended after the runs
- **Date:** 2026-09-08
- **Amends:** `docs/adr/0024-what-the-first-measurements-say.md`
- **Supersedes:** nothing

## Context

ADR-0024 records that every number this project has ever produced came from a nine-file synthetic
corpus, 19 chunks, authored by this project itself, and states plainly that a self-authored corpus
establishes only a lower bound on instability — a system unsteady on files it wrote itself will not
be steadier on documents it has never seen. That corpus benchmark has been deferred since. It is
deferred no longer: this ADR fixes, in writing and before any public-corpus run exists, every bar the
run will be judged against, the rule that sizes the corpus, and the protocol for authoring ground
truth.

**No public-corpus measurement has been taken at the time of writing.** The `eval/public/` lane, its
dataset, and its bars do not yet contain a single scored case. This document is the pre-registration;
the `## Result` section below is appended only once the runs described here have actually happened,
and every number that appears there is compared against the bars fixed here — not the reverse.

Two committed results already establish why pre-registration matters over post-hoc justification.
Phase 1's synthetic-lane run (ADR-0024) missed its `recall@5` floor (0.731 against 0.800) and its
answer-content-accuracy floor (0.895 against 0.950) with the floors fixed in advance; both stayed
where they were rather than moving to match the run. Phase 2's verifier experiment scored its two
pre-registered bars — one met, one missed — against thresholds fixed before the adjudication sample
was drawn. Both precedents are why this ADR states every bar as a falsifiable number now, while no
public-corpus data exists to tempt a bar toward a result.

## Decision

### Corpus

Source: SEC EDGAR, REIT registrants, forms `10-K` and `10-Q` only (`10-K/A` amendments excluded by
exact form match). Filing window `FILED_FROM = 2024-01-01`, `FILED_TO = 2025-12-31`, closed on
purpose — its XBRL frames have settled, so a later re-run of the fetch yields the same manifest, and
FY2025 10-Ks filed in 2026 are deliberately excluded rather than silently picked up by a re-fetch.
Exhibit files are included by filename hint (`ex19`, `ex21`, `ex23`, `ex31`, `ex32`, `ex97`, `ex99`)
and excluded when they match a derivative-rendering or index pattern (`R\d+\.htm`, `-index\.html?`,
`FilingSummary`, `Financial_Report`, `ex-?10`, `ex-?4`) — EDGAR's per-fact rendered pages are
derivative artifacts of the filing, not filed documents themselves, and including them would inflate
the document count without adding evidence.

**Corpus size is set by a pre-registered rule, not a target document count.** Registrants are walked
in allowlist order, most recent filings first, `10-K` before `10-Q` for the same registrant, exhibits
attached to their filing. The walk stops at the last filing that keeps every one of these true:

- cumulative chunks ≤ **10,000**
- cumulative projected ingest spend ≤ **`MAX_INGEST_SPEND_USD`** (the operator-set ceiling; see
  § Spend)
- cumulative projected wall-clock ≤ **8 hours**

Bounds win. The document, chunk, and filing count that results from the walk is reported as measured,
never assumed in advance — a ~500-document target and a 10,000-chunk bound are not jointly reachable
once real 10-Ks (hundreds of chunks apiece at `TARGET_TOKENS = 700`) replace a document-count guess.

### Estate configuration

The eighteen REIT measures confirmed for the `eval-public` tenant (`eval/public/measures.json`) and
the registrant canonical entities seeded from the corpus manifest are **estate configuration that
makes the corpus answerable**, not per-corpus tuning of the retrieval or extraction system. No
retrieval parameter, prompt, floor, or model routing decision is changed to fit this corpus; the
system under measurement is configured exactly as Phases 1–4 shipped it.

### Dataset

Minimum case counts per `eval/public/bars.json`'s `datasetMinimums`, frozen by content hash
(`corpus:freeze`) before any scoring run:

| Class | Minimum |
| --- | --- |
| `numeric` | 100 |
| `prose` | 25 |
| `abstention` | 20 |
| `restatement-conflict` | 15 |
| `entity-disambiguation` | 10 |
| `question-injection` | 10 |
| **Total** | **180** |

The brief's "≥150 cases with expected locators" is read against these minimums as: every class above
except `abstention` and `question-injection` carries at least one expected locator by construction —
`100 + 25 + 15 + 10 = 150` — so abstention and injection cases (which carry none, by design) sit
outside that 150 and outside the recall denominator.

**Numeric ground truth is machine-tagged, never model-authored.** Every numeric case's expected value,
period, and source accession come from SEC XBRL companyfacts — filer-tagged data, not a value an
answering or drafting model produced or checked. The period phrase in each question is built from the
XBRL fact's own `start`/`end` dates, never from `fy`/`fp` (which describe the filing, not necessarily
the period of a comparative-column fact) — using `fy`/`fp` would ask about the wrong year while the
locator and expected answer still silently agreed with each other. A hit counts only when the located
element's row or column label contains a matching term for the concept, because generic balance-sheet
totals share a bare numeric value across unrelated line items. Every corpus accession independently
reporting the same (concept, period, value) is included as an expected locator, so a correct citation
of a 10-Q's comparative column is never scored as a miss against a 10-K primary statement.
Restatement-conflict cases are the machine-detected pairs where the same (concept, period) key carries
two different values across two accessions in the corpus. Adversarial (question-injection) cases carry
the injection instruction in the question text itself, marked by a unique per-case token
(`injectionMarker`); because a public corpus plants no canaries of its own, the own-voice leak check
draws its token set from the union of the fixture-manifest canaries (synthetic lane) and these
per-case markers — deciding, for this lane, the open question ADR-0024 left about where an
injection-detection token comes from on a corpus nobody planted markers into.

### Bars

Hard bars — a missed bar sets a nonzero exit code and is reported as `MISSED`, never silently
adjusted:

| Metric | Bound |
| --- | --- |
| `recallAt5` | ≥ 0.80 |
| `recallAt10` | ≥ 0.90 |
| `mrr` | ≥ 0.70 |
| `citationPrecision` | ≥ 0.85 |
| `claimCoverageMean` | ≥ 0.85 |
| `answerRate` | ≥ 0.85 |
| `answerContentAccuracy` | ≥ 0.90 |
| `abstentionAccuracy` | ≥ 0.90 |
| `conflictRecall` | ≥ 0.80 |
| `conflictScopeAccuracy` | ≥ 1.00 |
| `canaryOwnVoiceLeakRate` | ≤ 0.00 |

`answerContentAccuracy` is registered at 0.90, below the synthetic lane's 0.95, because
`expectedAnswerContains` is a literal document rendering and financial prose routinely humanises a
figure the model may answer correctly but phrase differently — the bound is stated here in advance,
not lowered after seeing a miss.

Reported, not gated on this lane: `retrievalLatency` (p50/p95), `failingCases` (n≈180 over a single
run would be red by construction on a per-case count, so it is informational here),
`canaryVerifiedQuoteLeakRate`, and the five Phase 2/3B rates — `tabularGroundedRate`,
`coverageDropRate`, `contradictionDropRate`, `ledgerResolvedRate`, `ledgerGateSurvivalRate` — measured
on the public corpus for the first time but not gated by it.

Variance bars (N=5 passes, per-case resume): **zero abstention flips**, and **≥ 90% of answered
questions citing an identical citation set across passes**; claim-count spread is reported with no
bar, for the same reason ADR-0024 gives — no principled threshold exists, and inventing one to pass
would defeat the point of registering it.

Verifier bars (`scripts/experiments/verifier/verdict-metrics.ts`, `BAR_1_MIN_GATE_FAILURE_RATE` /
`BAR_2_MIN_CORRECT_CATCH_RATE`), evaluated over a majority-adjudicated sample from three independent
adjudicators:

- **Bar 1 — gate failure rate ≥ 0.20.** The verifier must actually be exercised: at least a fifth of
  drafted claims land in `not_grounded` or `no_evidence_retrieved`, or the sample contains too little
  signal to say anything about catch quality.
- **Bar 2 — correct-catch rate ≥ 0.70.** Of the claims the gate failed, at least 70%, on majority
  adjudication, are correctly failed (a real grounding problem, not a false catch).

### Spend

Estimates at Sonnet 5 pricing and `PASS_COUNT = 3`: ≈$0.03 and ≈2.5 s per prose chunk. Sample ingest
(one 10-K plus one 10-Q, for the measured cost model) ≈$15. Full ingest bounded at
`MAX_INGEST_SPEND_USD` — the operator-set per-phase cap. Scoring run ≈$5. N=5 variance ≈$25. Verifier
experiment ≈$15. The per-phase cap and the per-day spend ceiling are set by the operator in `.env`
(`MODEL_SPEND_DAILY_LIMIT_USD`, and `MODEL_SPEND_DAILY_LIMIT_INGEST_USD` if set separately) before the
sample ingest runs; the actual figures are recorded in `## Configuration` once set, never assumed here.

### Runs

- **Scoring, n = 1.** `eval --lane public --record`, spend-bounded, against the frozen dataset.
- **Variance, N = 5.** Per-case persisted, resumable by base git sha; the aggregate covers only
  complete passes.
- **Verifier, one run.** A seeded document sample, windowed drafting recorded per claim, adjudicated
  by three independent adjudicators (one neutral brief, one briefed to find the gate correct, one
  briefed to find it wrong) merged by majority; disagreements are recorded, not discarded.

### Not measured, carried

Recorded here as explicitly open, not resolved by this benchmark: the Haiku-vs-Sonnet extraction
routing decision (`ANTHROPIC_MODEL_FACT_EXTRACTION` exists but is unswept), the `numCandidates` sweep
(`mongo-hybrid.store.ts`), the retrieval-score abstention floor (`RETRIEVAL_SCORE_FLOOR`), live-
embedding drift, and inclusion of EDGAR's derivative `R*.htm` renderings. Each is its own experiment
needing its own pre-registration and its own spend; this ADR buys one benchmark of the product
configured exactly as it ships, not a sweep of its tunables.

## How it will be verified

`npm run corpus:fetch`, `npm run corpus:size`, one sample `npm run eval:public:ingest -- --only …`,
`npm run corpus:author-numeric`, hand-authored cases, `npm run corpus:freeze`,
`npm run eval -- --lane public --record`, `npm run eval -- --lane public --variance --runs 5
[--resume]`, `npm run experiment:verifier run --tenant eval-public`. Every command's output is
committed under `eval/public/results/` on a clean tree, never rewritten in place.

## Consequences

Once the `## Result` section below is filled in, the four rewritten documents
(`README.md`, `docs/global/architecture.md`, `docs/global/threat-model.md`, `.claude/CLAUDE.md`) may
state the public-corpus figures this ADR's runs actually produced, each annotated back to the results
file that produced it. They may not state a figure this ADR did not register a bar for, and they may
not describe a missed bar as fixed, adjusted, or explained away — a missed bar is a published result.
The nine-file synthetic corpus stays in place as the zero-cost regression gate; nothing here retires
it, and no synthetic figure is restated in the rewritten documents once the public-corpus figures
exist.

## Falsifiable signal (WATCH)

**W1.** A deliberate re-record of the scoring run on the frozen public-corpus dataset — same
`cases.json`, same corpus — that moves any hard-bar metric outside the N=5 variance band recorded for
it indicts this benchmark as unstable on its own terms, independent of the synthetic lane's known
instability. One such re-record landing inside the band is the confirming signal.

**Status:** Open — carried: no re-record has happened yet.

## Related

- `docs/adr/0007-eval-replay-cache.md`
- `docs/adr/0024-what-the-first-measurements-say.md`
- `docs/adr/0028-verifier-structured-support-atoms-and-contradiction-check.md`

## Configuration

Appended in 5.12 from the sizing probe.

## Result

Appended after the runs.
