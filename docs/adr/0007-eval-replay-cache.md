# ADR-0007 — Eval harness: replay-cached, locator-space ground truth, one fair-comparison protocol

- **Status:** Accepted — implemented, executed end-to-end, recorded and replayed twice against
  Atlas Local (`mongodb://localhost:27018/evidence-ops`, commit base `038eb54`), byte-identical
  both times — see Known bound 5
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

`eval/dataset/cases.json` and `eval/resolve-locator.ts` (an earlier slice) established locator-space
ground truth and proved every locator resolves to real text. Nothing yet ran the QA pipeline against
that dataset and scored it. `CachingModelProvider` (ADR-0006) already existed as the record/replay
seam for model calls; this slice is what actually drives the dataset through the pipeline, scores
it, and — separately — compares retrieval configurations under one fair protocol.

## Decision

### `npm run eval` drives the real pipeline, not a reimplementation of it

`eval/run.ts` bootstraps the real `AppModule` DI graph (`Test.createTestingModule`, the same
mechanism `test/utils/create-test-app.ts` uses, not `NestFactory.createApplicationContext` — that
factory has no `overrideProvider`, and three provider swaps are exactly what this needs). It then
calls `createActivities(app)` — the same activity closures `src/worker/activities.ts` exposes to a
real Temporal worker — for `retrieveEvidence` → `synthesizeAnswer` → `groundingCheck` per case. The
eval harness is a caller of the production pipeline, not a parallel implementation of it; a
pipeline behaviour change is automatically reflected in eval results without touching `eval/`.

Ingestion bypasses `DocumentsService.upload`, which starts an `ingestDocumentVersion` Temporal
workflow that needs a running worker process and a live Temporal dev server to actually execute
(Temporal is wired, per `.claude/CLAUDE.md`, but is a second process this eval harness does not
stand up). `eval/ingest-fixtures.ts` instead writes the fixture bytes to the document
store and calls `IngestionService.ingestVersion` / `FactsService.extractFacts` directly, in the
order the workflow would have run them. It runs under a dedicated `tenantId` ('eval'), wiping only
that tenant's rows first — the upload path's sha256 dedupe never runs on this path, so a second
run without the wipe would duplicate every chunk and fact and inflate retrieval recall with
duplicate hits.

### Two replay caches, not one

`CachingModelProvider` alone does not make a replay run free or deterministic: `IngestionService`
embeds every chunk and `MongoHybridRetrievalStore` embeds every query, both calling
`EmbeddingProvider.embed` directly, outside the model-call seam. `eval/providers/caching-embedding
.provider.ts` mirrors `CachingModelProvider` structurally (same `off`/`record`/`replay` modes, same
fail-loud `replay`-miss error, same duck-typed `ENOENT` cache-miss detection) and is bound in place
of `VoyageEmbeddingProvider` by `eval/bootstrap.ts`'s `EMBEDDING_PROVIDER` override. This was not
in the original plan — the plan named one cache; two are needed for "replay runs at zero API cost"
to actually hold, and that gap surfaced only by tracing every live call the pipeline makes, not by
reading the plan literally.

`eval/bootstrap.ts` swaps three provider seams via `Test.createTestingModule({imports:
[AppModule]}).overrideProvider(...)`: `MODEL_CACHE_OPTIONS` (off by default in `ProvidersModule` —
"turning on record/replay is an eval-harness/script decision", per that module's comment; this is
that decision), `EMBEDDING_PROVIDER` (wrapped in `CachingEmbeddingProvider`), and `WORKFLOW_ENGINE`
(swapped to `FakeWorkflowEngine`, matching `create-test-app.ts`'s precedent, even though this path
never calls it directly). `--record` populates `eval/cache/{model,embedding}/`; the default (no
flag) is `replay`. A replay miss throws — `ModelReplayCacheMissError` /
`EmbeddingReplayCacheMissError` — never falls through to a live call.

### Locator-space scoring: text-containment, not byte-range intersection

`eval/metrics/locator-overlap.ts` decides whether a retrieved chunk "covers" a dataset locator.
`xlsx-cell` is exact and structural: a chunk's spreadsheet locator is always `xlsx-region`
(`chunker.ts`'s `chunkSheet` never emits a per-cell chunk locator), so cell-in-range containment
(`addressMatches`, shared with `eval/resolve-locator.ts`) is precise. `pdf-page`/`docx-paragraph`
cannot use the equivalent equality check: `chunker.ts`'s `anchorLocator` anchors a multi-element
chunk to only its *first* page/paragraph, so a chunk spanning pages 2–4 still reports `page: 2`.
Equality would silently undercount recall for exactly the chunks a token-budget window is likely to
produce. Instead the dataset locator's own text is resolved (the same parsers ingestion used) and
checked for normalized containment in the chunk's text, via `locateQuote` — the identical function
`GroundingGateService` uses to verify a citation's quote against its cited chunk, applied here to a
whole page/paragraph instead of a citation-length excerpt. See Known bounds for what this trades
away.

Citation precision does not trust a citation's own `locator` field: `verifyClaim` checks a
citation's `chunkId`/`docVersionId`/`sha256`/`quote`, and only ever *replaces* `locator` when a
cell fact upgrades it — a citation that keeps its original chunk-level locator is never
cross-checked against the chunk it actually cites. Scoring citation precision through the cited
`RetrievedChunk`'s own locator (via the same `chunkOverlapsAnyLocator` used for retrieval recall),
rather than the model-authored `citation.locator`, is what keeps the metric honest.

### The retrieval-mode comparison protocol

`eval/retrieval/retrieval-modes.ts` implements lexical-only (`$search`), vector-only
(`$vectorSearch`), and hybrid (`$rankFusion`) as eval-side aggregations against the live
`evidence_chunks` collection, deliberately **not** by extending
`src/providers/retrieval/mongo-hybrid.store.ts` (out of this change's grant, and that file's own
comment already establishes the project's convention of duplicating index/collection constants
across the `src`/other-root boundary rather than importing across it — `tsconfig.build.json` scopes
`rootDir` to `src`). Every tuning constant — index names, RRF `k`, pipeline weights, candidate-pool
multipliers — is copied verbatim from `mongo-hybrid.store.ts`, so the *only* thing that varies
between the three `searchByMode` calls for one case is which pipeline(s) run. That is the protocol
this ADR is naming: a comparison where retrieval mode is the single independent variable, against a
frozen corpus, frozen chunking, and (via the embedding cache) frozen embeddings, is what M4's Qdrant
experiment needs to plug into later — a comparison that quietly varied a second thing at the same
time would produce a number nobody could trust.

### Deterministic metrics, no LLM judge

`eval/metrics/compute-metrics.ts` computes recall@5, recall@10, MRR, citation precision, mean claim
coverage, abstention accuracy (unanswerable cases), conflict recall (conflicting cases), and canary
leak rate — all from data the pipeline already produces (grounding-gate output, retrieval hits), no
model call to judge correctness. Canary leak rate is a **hard gate at 0**: `eval/run.ts` sets a
nonzero process exit code whenever any case's serialized outcome (not only `adversarial` cases —
see Known bounds) contains either canary marker token from `fixtures/data-room/manifest.json`.

### Ingest-once is what makes replay deterministic; the corpus fingerprint is what makes that checkable

An earlier version of this harness re-ingested the fixture corpus on every run. That broke replay
silently: Atlas Search is free to reorder results across two ingests of identical bytes, a
reordered retrieval set changes the assembled synthesis prompt, and a changed prompt is a changed
cache key — so a "replay" could quietly miss the cache it was supposed to hit. Ingestion is now
opt-in behind `--ingest`; the default reuses whatever corpus already exists for the `'eval'` tenant
and fails closed, naming the exact remediation command, when none does. Silently re-ingesting on a
cache miss here would reintroduce the exact nondeterminism `--ingest` exists to make opt-in.

Reuse is what makes replay deterministic. It is not, by itself, what makes that determinism
*checkable* by anything other than trusting the harness. `eval/compute-corpus-fingerprint.ts`
hashes the sorted set of `evidence_chunks._id` values — sha256, order-independent so query-planner
ordering noise can never be mistaken for a real corpus change — into a single fingerprint, written
to `eval/cache/manifest.json` at `--record` time and asserted against the live corpus at every
replay. A corpus that drifted under a recorded cache (re-ingested, re-chunked, or simply pointed at
the wrong database) fails loudly with a fingerprint mismatch instead of a confusing per-case cache
miss, or worse, a silent score against evidence the cache was never recorded against. The
fingerprint is what turns "this replay is deterministic" from a claim this ADR makes into a claim
`npm run eval` checks on every invocation. See Known bound 7 for what it does *not* check.

### `conflictRecall` needed two independent, deterministic fixes — multi-pass agreement was not one of them

Multi-pass fact extraction (`agree-facts.ts`, `prose-fact-extractor.ts`) was designed on the belief
that `conflictRecall`'s failure was sampling variance: one extraction pass measurably returned 8, 2,
and 0 facts for byte-identical input across live runs, so the fix was three independent passes,
keeping only what at least two agreed on. That belief did not survive measurement. `conflictRecall`
was `0.00` before multi-pass agreement shipped and `0.00` after — a real re-record and replay, not a
hunch, and the metric did not move at all. Recording the belief and why it was wrong is more useful
here than deleting it: multi-pass agreement is a genuine fix for a genuine problem (variance in
*which* facts survive extraction, run to run, over otherwise-identical input) — it was simply not a
fix for this one.

What actually moved `conflictRecall` from `0.00` to `1.00` (measured 2026-08-11, replayed twice
against the recorded cache, byte-identical both times) were two independent, deterministic pins,
both of which had to be pulled before either fact could reach the metric:

1. **The fact extractor's verbatim-quote check rejected every quote spanning a PDF hard line
   wrap**, deterministically — not a coin flip multi-pass agreement could average away, since none
   of three passes ever produced a quote that survived the check in the first place. The PDF side
   of the seeded Northgate Business Park conflict wrapped exactly this way, so it was never stored
   as a fact, and a conflict needs two stored facts to exist. See ADR-0004 bound 8 for the fix
   (sharing `locateQuote`, the same normalized-containment verifier the answer boundary already
   used for citations, instead of a stricter ad hoc `.includes()` check).
2. **`conflictRecall` scores an answer *outcome* the application had no deterministic path to
   reach**, independent of whether the underlying facts existed. Even with both sides of a conflict
   stored, nothing in the wired pipeline could turn "these two facts disagree" into a
   `conflicting_evidence` answer for a claim citing only prose evidence — the gate's own
   conflict-forcing ran off `cellFacts` (`xlsx-cell`-only) alone. See ADR-0004 bound 9 for the fix
   (`findEitherSideConflict` in `src/worker/activities.ts`, "model hints, server verifies").

Both fixes had to land before the metric moved: closing only the quote-check gap would have
surfaced a fact with nothing to force the outcome from it; closing only the outcome-forcing gap
would have had no second fact to force `conflicting_evidence` from. The now-stored PDF-side fact
resolves to page 2 — not the chunk's own page-1 anchor locator, since the chunk merges elements
from two pages and `resolveFactLocator` recovers the fact's actual source element rather than
defaulting to the chunk's anchor (ADR-0008) — which is the concrete, checkable proof that the
locator half of the fix, not only the outcome-forcing half, is doing real work.

## Known bounds

1. **Deterministic metrics measure groundedness and retrieval, not correctness.** Recall, MRR, and
   citation precision all measure whether the pipeline found and cited the right evidence. None of
   them can catch a claim that cites real, on-topic evidence and still draws the wrong conclusion
   from it — the same citation-verifier-not-reasoning-verifier bound ADR-0004 states for the
   grounding gate itself applies one layer up, to this harness's scoring. An LLM-judge metric (M5)
   is the only piece of this that could catch that class of failure, and it is explicitly out of
   scope here.

2. **A replay cache freezes model and embedding behaviour at record time.** Every metric this harness
   reports is only as current as the last `--record` run. A model or embedding-model upgrade changes
   real answers and real vectors without changing any cache key this harness computes (keys hash
   provider/model/params/prompt — a new model version is a different `model` string and therefore a
   genuine cache miss, forcing re-record; but a *behavioural* change under the same model string,
   e.g. a vendor-side model update, is invisible to a key that only hashes the string). Re-recording
   after any such change is a deliberate, manual step — the eval cannot detect drift between an old
   recording and current live behaviour on its own.

3. **Locator overlap is text-containment, not a byte-range intersection.** For `pdf-page`/
   `docx-paragraph`, "this chunk covers this locator" is decided by whether the locator's resolved
   text is verbatim-contained (normalized) in the chunk's text, not by comparing declared page/
   paragraph ranges — `EvidenceLocator`'s prose variants only carry an anchor point (first element),
   not a span. This is accurate for whether the evidence was actually retrieved (the real recall
   question) but cannot report which offset within a chunk it starts at.

4. **The retrieval-mode comparison constants are hand-duplicated, not shared.** `retrieval-modes.ts`
   copies `mongo-hybrid.store.ts`'s tuning constants verbatim rather than importing them (see
   Decision). A future change to those constants in the store must be mirrored here by hand, or the
   comparison protocol silently stops being fair — nothing currently enforces the two stay in sync
   beyond this note and matching comments in both files.

5. **Closed: executed end-to-end, recorded, and replayed byte-identical.** This bound originally
   read: "Not executed end-to-end in the session that wrote it. The sandbox this was implemented in
   cannot bind sockets (no Mongo) or reach the network (no live Anthropic/Voyage calls), so
   `eval/cache/` is currently empty and `npm run eval -- --record` has not been run." That gap is
   closed: `npm run eval -- --ingest --record` has run against Atlas Local
   (`mongodb://localhost:27018/evidence-ops`), and `npm run eval` (replay) has run twice more
   against that recording, byte-identical both times — same `corpusFingerprint`
   (`6a8119f6a1c49bd8d00c172615314862ecf11b3481df479a087444672ff8435a`), same metrics, zero live API
   calls on either replay. The retrieval-mode comparison (`retrieval-modes.ts`) queries the live
   `evidence_chunks` collection directly, so it runs on every eval invocation, replay included, not
   gated behind `--record` the way the model/embedding caches are.

6. **`computeChunkId` scopes by tenant, not by document — a same-tenant collision is still
   possible.** The live integration suite caught a real defect in this ADR's original derivation:
   `documentVersionSha256 + ordinal + locator` alone is a pure function of content, so the same
   bytes ingested under two different tenants produced the same `EvidenceChunk._id` and the second
   ingest's `insertMany` died on `E11000 duplicate key error` — `IngestionService`'s cleanup deletes
   by `documentVersionId`, so it never clears a colliding row a different tenant owns. The fix
   (`0008-tenant-scoped-evidence-chunk-ids.ts`) folds `tenantId` into the hash. `documentId` would
   also close the narrower same-tenant/two-distinct-document collision, but it is minted per
   document row and the eval harness deletes and recreates its documents on every run
   (`eval/ingest-fixtures.ts` wipes the `'eval'` tenant first) — folding it in would reintroduce
   per-run id drift and break the replay property this ADR's whole design depends on. `tenantId` was
   chosen because it is stable per caller (`'eval'`, `'default'`) and closes the isolation break
   this ADR's brief actually named as a requirement; the same-tenant/two-document collision is left
   open as a known bound, not fixed silently. `computeChunkId`'s own doc comment
   (`src/features/evidence/ingestion/compute-chunk-id.ts`) states this trade-off inline. This is the
   second time a chunk-id derivation change has invalidated `eval/cache/` — see Consequences.

7. **The corpus fingerprint pins content, not location — verified empirically, not theorized.** It
   hashes the sorted set of content-addressed chunk ids (`computeChunkId`, ADR-0008), so identical
   fixture bytes ingested into an entirely different Mongo server produce an identical fingerprint.
   A green fingerprint proves the corpus a cache was recorded against still exists with the same
   content; it says nothing about which server holds it. This was checked directly rather than
   assumed: a replay pointed at the wrong database prints the same fingerprint as one pointed at the
   right one. A fingerprint match is a necessary check on this harness's determinism claim, not a
   sufficient one — pointing the connection string at the intended server is still on whoever runs
   it.

## Consequences

**Good.** `npm run eval` scores the real pipeline, not a parallel reimplementation — a synthesis or
grounding-gate change is reflected in the next eval run automatically. Once recorded, replay runs the
full dataset at zero API cost with byte-stable output — proven, not assumed: two replays against the
same recording produced identical metrics and an identical corpus fingerprint. The retrieval-mode
comparison gives M4's future Qdrant experiment a protocol to plug into rather than a number to argue
about the methodology of.

**Costs.** Two replay caches instead of one, and a second retrieval implementation
(`retrieval-modes.ts`) that must be kept in sync with `mongo-hybrid.store.ts` by hand.
`0008-tenant-scoped-evidence-chunk-ids.ts` (see Known bound 6) invalidated `eval/cache/` a second
time — every recorded prompt embedded a `chunkId` that had just changed — so `--record` had to run
again before the next replay; it has, see Known bound 5.

**Deferred, deliberately.** An LLM-judge correctness metric (M5), closing bound 4 (sharing the
tuning constants instead of duplicating them, once the retrieval store's own module boundary is
revisited), and closing bound 6 (scoping `computeChunkId` by `documentId` as well, if a future
change makes eval document ids stable across runs) are all real next increments, not designed here.

## Interview framing

> Three things I'd flag before anyone else does. First, I found a gap the plan didn't call out: a
> single model-call cache does not make a replay run free — ingestion and query embedding both call
> the embedding provider directly, so I built a second cache for that, mirroring the first one's
> exact record/replay/fail-loud shape. Second, I got this running end to end, and the interesting
> part isn't that it's green — it's that I was wrong about why one of the numbers was red before
> that. I built multi-pass fact extraction assuming it would fix `conflictRecall`; it shipped and the
> metric didn't move at all. The real fixes were two deterministic gaps downstream of extraction
> agreement entirely — a quote-verification check too strict for a PDF's own line wraps, and no path
> from "these two facts disagree" to a `conflicting_evidence` answer for a claim that only cited
> prose. I'd rather record that I was wrong about the mechanism than quietly rewrite the history once
> the real fix landed. Third: the corpus fingerprint that makes this harness's determinism claim
> machine-checked pins content, not location — it hashes content-addressed chunk ids, so it proves
> the corpus still has the content a cache was recorded against, and it is structurally incapable of
> telling you whether that corpus is sitting on the right server. I checked that directly rather than
> assumed it, because a green check that implies more than it verifies is worse than no check at all.
