# ADR-0007 — Eval harness: replay-cached, locator-space ground truth, one fair-comparison protocol

- **Status:** Accepted — implemented, unit-tested; not yet executed end-to-end (needs a reachable
  Mongo and live `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY` to `--record` a first cache, neither
  available in the sandboxed session that wrote it — see Known bounds)
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

Ingestion bypasses `DocumentsService.upload`, which fire-and-forgets an `ingestDocumentVersion`
Temporal workflow that has no worker to run it (Temporal is scaffolded but not wired — see
`.claude/CLAUDE.md`). `eval/ingest-fixtures.ts` instead writes the fixture bytes to the document
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

5. **Not executed end-to-end in the session that wrote it.** The sandbox this was implemented in
   cannot bind sockets (no Mongo) or reach the network (no live Anthropic/Voyage calls), so `eval/cache/`
   is currently empty and `npm run eval -- --record` has not been run. `npm run tsc`, `lint:check`,
   `format:check`, and the pure-logic unit tests (`test/eval/**`, run via `npm run test`) all pass;
   the full pipeline run, `--record`, and the retrieval-mode comparison against real indexes are
   unverified until an environment with both is available to run them.

## Consequences

**Good.** `npm run eval` scores the real pipeline, not a parallel reimplementation — a synthesis or
grounding-gate change is reflected in the next eval run automatically. Once recorded, CI can run the
full dataset at zero API cost and byte-stable output. The retrieval-mode comparison gives M4's future
Qdrant experiment a protocol to plug into rather than a number to argue about the methodology of.

**Costs.** Two replay caches instead of one, and a second retrieval implementation
(`retrieval-modes.ts`) that must be kept in sync with `mongo-hybrid.store.ts` by hand.

**Deferred, deliberately.** An LLM-judge correctness metric (M5) and closing bound 4 (sharing the
tuning constants instead of duplicating them, once the retrieval store's own module boundary is
revisited) are both real next increments, not designed here.

## Interview framing

> Two things I'd flag before anyone else does. First, I found a gap the plan didn't call out: a
> single model-call cache does not make a replay run free — ingestion and query embedding both call
> the embedding provider directly, so I built a second cache for that, mirroring the first one's
> exact record/replay/fail-loud shape. Second, I could not actually run this: the environment I
> built it in has no Mongo socket and no live API keys, so the cache is empty and the pipeline run
> is unverified beyond type-check, lint, and the pure-logic unit tests. I'd rather say that plainly
> than claim a green run I don't have.
