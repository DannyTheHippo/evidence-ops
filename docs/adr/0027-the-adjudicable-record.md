# ADR-0027 — The adjudicable record, and the Phase 1 ledger substrate that makes it possible

- **Status:** Accepted — implemented as the `measures` collection, the fact-schema measure stamp,
  the ledger read model, and a direction-aware eval comparison gate
- **Date:** 2026-09-03
- **Supersedes:** —
- **Amends:** —, but it invalidates the read-only framing in `metrics.controller.ts`'s former
  comment (`METRIC_ONTOLOGY has no operator-authoring surface, and this controller only ever
  reads it`) — measures now have a confirmation queue and an authoring surface

## Context

**Identity sentence.** Evidence Ops holds a durable, adjudicable record of what the estate's
documents actually say: claims re-checked by code against the bytes, disagreements surfaced and
decided by a human, defensible to someone who wasn't in the room.

Five findings motivated re-centering the product around that record rather than around chat or
retrieval quality:

- Positioning had been narrowed four times and reopened twice; the one-sentence answer produced
  once was never confirmed.
- The primary surface was declared to be MCP once; the following weeks went into two browser
  redesign cycles instead, never reconciled against that declaration.
- Every number in the repository comes from nine self-authored files; the real-corpus benchmark
  had been deferred twice.
- `verify_claims`, the tool the README leads with, grounded 0 of 60 claims drafted from
  spreadsheets and adjudicated at 25% correct catches against a pre-registered 70% bar.
- The fact and conflict layer was hard-coded to eight commercial-real-estate metrics
  (`src/features/evidence/facts/metric-ontology.ts`), so it could not serve a second engagement
  without a code change.

## Decision

### D1–D12, verbatim from the parent plan's interview

| # | Question | Decision |
| --- | --- | --- |
| D1 | Identity | The adjudicable record (sentence above). |
| D2 | Primary surface | MCP primary. Browser becomes an operator console: estate, ledger, adjudication, answers, admin. The Search page is cut; the Ask and Answers pages are kept and consolidated into one Answers area (see D13). A consolidation, not a sixth redesign. |
| D3 | Measures | Header-inferred measures with a confirmation queue (evidence auto-applies, inference proposes). No packs, no policy authoring, no governance layer; the Aug 25 cut stays cut. |
| D4 | Measurement order | Build first, measure last: the real-corpus benchmark is the final phase. |
| D5 | Verifier | All three: structured-fact matching; atomic decomposition with deterministic coverage; a lowering-only contradiction check (flag-off, measured before enable). |
| D6 | Ingress | Drop folder and exports stay the ingress; add a `submit_evidence` MCP tool so an assistant that already has connectors pushes bytes in. No connector fleet. |
| D7 | Providers | One additional OpenAI-compatible provider (model and embeddings) behind the existing ports. No SDK swap. |
| D8 | Phase gate | Synthetic nine-file replay lane must not regress on any existing metric, and each phase adds a metric for what it changes. |
| D9 | Scope adds | Ledger-first answering; attestation export bundle; HTML parser. OCR stays out. |
| D10 | Stack | Keep NestJS, Mongo Atlas Local hybrid retrieval, Temporal, React SPA. |
| D11 | Aug 27 open steps | Folded into the phases below; the old plan gets a History entry naming where each went. |
| D12 | Plan depth | Every phase detailed now; one file, parent digest plus one child section per phase, each with its own digest and Todo Steps. Phase 3 is one phase with two child plans (3A, 3B). After approval the child sections are split into their own files. |
| D13 | Console Q&A | Keep the Ask and Answers pages, consolidated into one Answers area: `/answers` is a composer plus the history of answers and verifications, `/answers/:id` is the answer detail with the attestation bundle and download, `/answers/verifications/:id` the verification detail. Search stays cut. The console composer is an operator tool; MCP remains the integration story in README and ADR. No verify-from-console form. |

### Cut list

Deleted outright in the phase named. Git history is the record.

| Cut | Phase | What goes |
| --- | --- | --- |
| Closed metric allowlist as the fact vocabulary | 1 | `METRIC_IDS`/`METRIC_ONTOLOGY` as a code constant stops being the source of truth; it becomes the seed for the `measures` collection. `ACTIVE_PACK_ID`/`ACTIVE_PACK_VERSION` stamps stay on rows for provenance; new rows stamp `measureId`/`measureVersion`. |
| Search page | 4 | `web/src/pages/SearchPage.tsx`, its test, its nav entry, the client functions only it calls. Evidence search happens over MCP (`search_evidence`) and through an answer's citations; the README documents the Claude Desktop configuration. |
| Ask and Answers as separate destinations | 4 | `AskPage.tsx` folds into a redesigned `AnswersPage.tsx` (composer above the history of answers and verifications); `AnswerDetailPage.tsx` gains the attestation bundle and download; a verification detail joins the same area. The `/ask` route goes; `/answers` and `/answers/:id` stay (D13). |
| Separate Conflicts and Approvals pages | 4 | Merged into one Adjudication queue with the decision record visible on every row. |
| Canonical entities as a top-level destination | 4 | Moves under Ledger. |
| Stale claims | 1, 5 | CLAUDE.md "three MCP tools" (there are five); `README.md:803` "no generated OpenAPI client" (ADR-0023 and `web/src/api/schema.ts` contradict it); ADR-0004 missing the amendment note ADR-0022 declares. Phase 5 rewrites README, architecture and threat model against the measured numbers. |

### Bounds carried by Phase 1

No signing key for the attestation bundle. No OCR. Header-inferred measure proposals are
header-only — a numeric column with no header carries no signal to propose from, and a
prose-labelled proposal (a value named in running text rather than a column header) is out of
scope for inference and is recorded only as a seed row, never proposed.

### Phase 1 mechanics

**Measures collection and `version` semantics (decision 9).** A seed measure starts confirmed at
`version: 1`. A header-inferred proposal starts proposed at `version: 1`. `confirm` always bumps
`version` by 1, with or without edits alongside the confirmation. A `PATCH` on an already-confirmed
measure also bumps `version` by 1. Facts keep the `measureVersion` they were extracted under, as
provenance parallel to the existing `packVersion` stamp; every consumer evaluates against the
measure's current definition, not the version a fact was stamped with.

**The exclusion invariant (decision 10).** Facts stamped against a proposed measure exist in
`extracted_facts` but are invisible to `scanForConflicts` (both paths), `findCellFacts`,
`findFactsForChunks`, and `LedgerService.listCells`/`resolveValue` — every one of those queries
filters on `measureStatus: 'confirmed'`. Only `GET /measures` (via `proposedFrom`) and
`GET /ledger/facts` (labelled by `measureStatus`) surface them before confirmation. Confirming a
measure flips `measureStatus` to `'confirmed'` on its facts and rescans their groups.

**Synchronous in-request rescan.** Confirming a measure runs the conflict rescan inside the
confirm request rather than handing it to a workflow. The evidence for that choice: the
incremental rescan path costs one indexed `find` on
`extracted_facts_tenantId_groupKeyNormalized`, two `$in` joins, one conflicts `find`, then one
`save()` per retracted-or-grown conflict and one `insertMany` — bounded by one spreadsheet column
of facts for a header-proposed measure. `POST /canonical-entities/near-matches/scan` already runs
a tenant-wide scan synchronously in-request, so this is not a new pattern in the codebase. A
workflow-based rescan was rejected because `FakeWorkflowEngine` never executes activities, so no
e2e test could observe it running; it adds a fourth workflow, an activity, a run row, and a
polling contract for a call that is cheap today.

The rescan fails **open**: confirmation persists first, and a rescan throw is caught, recorded on
`Measure.lastRescan` (`status: 'failed'`, the error message, `durationMs`), and returned to the
caller — never rolled back. The human decision to confirm a measure is never held hostage to a
measurement running afterward. WATCH W2 below is the signal that would move this to a workflow.

**The replay-cache ordering invariant (decision 4).** Seed measure rows copy `METRIC_ONTOLOGY`
verbatim, and `orderForExtraction` places `origin: 'seed'` rows in `METRIC_IDS` order, then any
other rows by slug ascending. For a seed-only tenant this makes the extraction prompt and its
`z.enum` JSON schema hash byte-identical to the committed eval replay cache. Ordering by
`createdAt` or `_id` was rejected as nondeterministic under `insertMany` timestamp assignment and
across the migration-vs-Mongoose insertion paths.

**The header-inference grammar.** A slug derives from the header text minus parenthetical and unit
tokens, matched against `^[a-z][a-z0-9_]{0,63}$`. `valueType` infers first from header tokens —
`%`/`percent`/`pct` → percentage, `usd`/`$` → currency, `sf`/`sq ft`/`sqft`/`square feet` → area,
`years`/`yrs` → duration (years), `months` → duration (months) — and falls back to the rendered
cell text when no header token matches: a cell containing `%` infers percentage, one containing
`$` infers currency, otherwise count. A column proposes a measure only when every non-empty data
cell under that header is numeric; a single non-numeric cell rules the whole column out.

**The `EXTRACTION_HEADER_PROPOSALS` two-step enable.** The env var defaults to `false` (zod
default). Step one ships the collection, seeds, stamps, and ledger unconditionally, with the flag
off and a pinned inertness test proving an unmatched numeric column proposes nothing while off.
Step two is a compose-only flip to `true`, carrying WATCH W1 below.

**The `--compare` direction rule and its exit-code caveat.** `canaryOwnVoiceLeakRate` and
`canaryVerifiedQuoteLeakRate` regress on any upward move; every other gated metric regresses on any
downward move. `caseCounts.*` and `retrieval.caseCount` are sizes, not quality signals, and are
excluded from the comparison entirely. The eval process still exits 1 on the pre-existing absolute
floors (recall@5 0.731 against a 0.80 floor, for example), so the phase gate reads the comparison
result — `baselineComparison.regressions.length === 0` in the JSON, and the
`eval: baseline comparison — 0 regression(s)` line on stdout — not the process exit code.

**No `periodStart`/`periodEnd` backfill migration (decision 8).** `migrations/0001-baseline.ts` is
the only migration and the local database is reset and re-ingested as part of this phase; there is
no production database to backfill. Period bounds are stamped at extraction time from
`parsePeriodKey(period).range`.

**`GET /ledger/entities` as an additive route.** Beyond the routes the original brief named, this
route backs a future console entity list; it is additive to the REST surface and later phases may
use it or leave it unused.

## How it was verified

`measure-definition.spec.ts` pins the replay-cache ordering invariant: `toMeasureDefinitions`
applied to `orderForExtraction` of the seed rows deep-equals `METRIC_ONTOLOGY` projected to
`MetricDefinition` fields. `facts.service.spec.ts` pins both the `EXTRACTION_HEADER_PROPOSALS`
inertness claim on the shipped default and the measure-stamping invariant on extraction.
`resolve-cell.spec.ts` exercises the full `LedgerState` state table (`single`, `adjudicated`,
`conflicted`, `unknown`). `compare-baseline.spec.ts` covers the direction-aware regression rule
for every gated metric plus the count exclusions. The two new e2e files,
`measures.e2e-spec.ts` and `ledger.e2e-spec.ts`, assert the new response shapes by exact key set.

The ADR-number sweep from step 1.5 closes the Aug 27 plan's open step 10c: every `ADR-00NN` /
`adr/00NN` reference in the repository resolves to a file in `docs/adr/` (verified by the sweep in
step 1.5; expected set 0001–0026, zero missing).

## Consequences

**Good.** The fact vocabulary is no longer a closed code constant; a second engagement adds
measures through the confirmation queue instead of a code change. The rescan cost of confirming a
measure is bounded and visible on the row itself (`lastRescan`) rather than hidden in a queue.

**Costs.** `verify-claim.ts`'s check 4 (metric mention) stays on the seed `METRIC_ONTOLOGY` until
Phase 2 widens it to read `measures`; a confirmed header-proposed measure's facts fall back to
raw-text support in a verification until then. The `state` filter on `GET /ledger` resolves every
matching group before paging, which is acceptable at the pilot corpus size (hundreds of groups)
but is a bound, not a design goal.

**Deferred.** Widening `verify-claim.ts` to the live `measures` collection is Phase 2 scope.
Paging a resolved-and-filtered ledger without resolving every candidate group first is undecided
and untouched by this phase.

**Known bound — a header's own unit marker is not authoritative.** `parsePercentageDisplay` reads a
markerless cell as the metric's factor-1 unit whenever `strictPercentUnitResolution` is off, which
is the default, so a bare `5.25` under a column headed `Cap Rate (%)` would record `5.25 ratio` —
a value 100× the intended `5.25 percent`. The header states the unit unambiguously and the parser
ignores it, consulting `parseHeaderUnitMarker` only when the flag is on. Header inference is held
to the same bound rather than widening it: **both** of the extractor's two routes out of a header —
the slug fallback that would resolve `Cap Rate (%)` to `cap_rate`, and the proposal path that would
mint a new measure from it — are gated on the same predicate,
`strictPercentUnitResolution || parseHeaderUnitMarker(header).unit === undefined`. A marker-carrying
header therefore resolves to nothing *and* proposes nothing while the flag is off, so the column is
skipped outright instead of being recorded at the wrong scale. Gating only the match route would be
worse than the original exposure: `deriveMeasureSlug` strips the parenthetical, so `Cap Rate (%)`
derives the slug `cap_rate`, which is already a confirmed seed. The proposal path would find that
row and stamp the column's cells `confirmed` against it on the spot — no proposal row, no queue
entry, nothing for an admin to review — while the cells themselves were parsed under a synthetic
definition with a different unit table. Making the marker authoritative regardless of the flag is
the better reading — a stated unit is evidence, not a guess — but it changes flag-off behaviour for
existing corpora and is therefore left to a cycle that can measure the change against a real one.

**Known bound — the proposal cap is per document, not per tenant.**
`MAX_HEADER_PROPOSALS_PER_DOCUMENT` (200) bounds how many distinct measures one workbook's headers
may propose, counted across its sheets so splitting columns over sheets cannot multiply it. Columns
past the cap mint no proposal and no facts, and the document's `reducedFidelityReasons` names how
many were skipped. What this does not bound is a tenant's running total: 200 uploads of 200 novel
headers each still fill the confirmation queue with 40,000 rows. A tenant-wide bound needs a policy
decision about what happens when it is reached — refuse the ingest, or accept it and stop proposing
— and neither is obviously right for an estate that is genuinely still discovering its vocabulary,
so it is left to the cycle that can watch a real queue.

## Falsifiable signal (WATCH)

- **W1.** With `EXTRACTION_HEADER_PROPOSALS=true` on docker-local,
  `db.measures.countDocuments({status:'proposed'})` after `npm run eval -- --ingest` stays 0 — the
  fixture corpus has no unmatched numeric column, so the flag flipping on should propose nothing
  against it. On the first real engagement, if rejected proposals exceed confirmed ones over a
  month, the flag goes back off and proposals return to being flag-gated pending a better
  inference grammar.
- **W2.** `Measure.lastRescan.durationMs` on confirm stays under 5000 ms. Above that threshold, the
  synchronous in-request rescan moves to a Temporal workflow instead.
- **W3.** CI's `npm run eval -- --ingest` replay lane stays cache-hit. A replay miss means the
  seed/ordering invariant that keeps the extraction prompt byte-identical to the committed cache
  has broken.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md`
- `docs/adr/0013-tenant-provisioning-and-default-tenant-demotion.md`
- `docs/adr/0015-survivorship-policy.md`
- `docs/adr/0021-evidence-lifecycle-and-withdrawal.md`
- `docs/adr/0023-spa-types-generated-from-openapi.md`
- `docs/adr/0025-one-baseline-migration-instead-of-a-chain.md`
