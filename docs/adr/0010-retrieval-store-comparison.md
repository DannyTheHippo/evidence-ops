# ADR-0010 — Retrieval store comparison: MongoDB Atlas Local stays, Qdrant is not adopted

- **Status:** Accepted — measured against a live Qdrant benchmark, not argued from vendor claims
- **Date:** 2026-08-12
- **Supersedes:** —

## Context

ADR-0002 chose single-store MongoDB for retrieval but explicitly deferred, not rejected, a
dedicated vector database: "the retrieval interface is a single port
(`src/providers/retrieval/retrieval-store.interface.ts`'s `RetrievalStore`), and the eval protocol
varies only a `RetrievalConfig {mode, k, weights}` against a frozen corpus, chunking and embedding
set — so a competing store can be measured on the same ground rather than argued about." ADR-0007
then built exactly that ground while implementing something else — the lexical/vector/hybrid
retrieval-mode comparison (`eval/retrieval/retrieval-modes.ts`, `runRetrievalComparison`) — and
named this ADR's obligation in so many words: "The retrieval-mode comparison gives M4's future
Qdrant experiment a protocol to plug into rather than a number to argue about the methodology of."

This ADR is M4. It closes ADR-0002's deferred question with a measured number, using ADR-0007's
protocol unmodified, not a fresh comparison built to a different standard.

The question this experiment answers is not "is Qdrant a capable vector database" — obviously yes.
It is whether a second, dedicated datastore earns its cost against what MongoDB's `$vectorSearch`
already measures inside the single store ADR-0002 already chose.

## Decision

**Keep MongoDB Atlas Local as the retrieval store.** Qdrant is not adopted, in production or
alongside Mongo. It stays as profile-gated benchmark infrastructure only — a `docker-compose.yml`
service under `profiles: [qdrant]`, never `full`, and `@qdrant/js-client-rest` stays a
devDependency, so it never ships in the runtime image.

## Method

The benchmark enters through `runRetrievalComparison`'s injectable `search` seam
(`eval/retrieval/retrieval-comparison.ts`), the same function ADR-0007 wrote to score
lexical/vector/hybrid. `eval/run.ts`'s `--qdrant` flag is opt-in: an unflagged `npm run eval` needs
no Qdrant container and executes an unchanged code path — verified empirically, not assumed, by
running the unflagged path and confirming it still produces the three-row Mongo-only table. Passing
`--qdrant` starts a fourth mode, `qdrant-vector`, by populating `evidence_chunks_benchmark`
(`eval/qdrant/qdrant-benchmark-store.ts`) from the tenant's already-embedded `evidence_chunks` rows
and routing that one mode through `searchQdrantVector` via `makeQdrantAwareSearch`
(`eval/qdrant/qdrant-aware-search.ts`), while `lexical`/`vector`/`hybrid` keep running the original
Mongo path unchanged.

Qdrant runs under `docker compose --profile qdrant up -d`, never inside the `full` profile that is
the product demo stack — this benchmark's own conclusion is that Mongo stays the retrieval store, so
its infrastructure does not belong in the stack that ships. The benchmark collection is deleted and
recreated from scratch on every run (`populateQdrantCollection`), never upserted into whatever a
long-running container already holds, so a stale point from a previous corpus can never inflate
recall silently.

Point identity: Qdrant point ids must be an unsigned 64-bit integer or a UUID, and this project's
content-addressed `EvidenceChunk._id` (`computeChunkId`, ADR-0008) is neither — a 64-character sha256
hex digest. `chunkIdToPointId` (`eval/qdrant/qdrant-point-id.util.ts`) reformats the digest's first
32 hex characters into UUID 8-4-4-4-12 grouping rather than hashing again, because a second hash
would need to be reversible to recover the real `chunkId` from a hit. It doesn't need to be: the real
`chunkId` travels in the point's payload (`chunk-to-point.util.ts`'s `toPoint`), so every Qdrant hit
still resolves back to the exact evidence chunk it came from.

Vector dimension is asserted from the stored embeddings (`assertUniformEmbeddingLength`) rather than
read from `VOYAGE_DIMENSIONS` config, both because `process.env` is confined to one file in this
project and because deriving it self-verifies against what was actually indexed instead of trusting
a value that could drift from the real data. `distance: 'Cosine'` mirrors migration 0003's vector
index configuration and its stated reasoning: nothing in `VoyageEmbeddingProvider` requests or
asserts unit-length vectors from the Voyage API, so a dot-product distance would only be equivalent
to cosine similarity by an unconfirmed assumption, and getting that wrong doesn't error — it silently
mis-ranks.

## Result

Measured 2026-08-12 by the orchestrator (not a subagent — the sandbox cannot bind sockets or reach
Docker), replay mode, zero API calls, corpus fingerprint `6a8119f6a1c49bd8…` unchanged from the
recording ADR-0007 closed its own bound 5 against.

| Mode | Recall@5 | Recall@10 | MRR | Cases |
| --- | --- | --- | --- | --- |
| lexical | 78.3% | 82.6% | 0.577 | 23/23 |
| vector | 82.6% | 91.3% | 0.648 | 23/23 |
| hybrid | 82.6% | 82.6% | 0.667 | 23/23 |
| qdrant-vector | 82.6% | 91.3% | 0.648 | 23/23 |

The headline finding, stated without overreach: `qdrant-vector` is **identical** to Mongo's `vector`
on all three metrics. Same vectors (both read the same `evidence_chunks` embeddings), same cosine
metric, same top-k, same scorer — and the two engines rank the corpus the same way. The honest
reading is that on this corpus the retrieval **engine** is not a differentiator; the embedding model
and the fusion strategy are. Note also the standing oddity ADR-0002 and the eval walkthrough already
admit and which this experiment does not change: `vector` beats `hybrid` on recall@10 (91.3% vs
82.6%) on this corpus while `hybrid` leads MRR (0.667 vs 0.648) — that pattern predates this ADR and
is not a finding of it.

## The bound that must carry as much weight as the result

The corpus is **12 chunks**. At that size both engines are effectively doing exhaustive search, so
Qdrant's HNSW index never gets an opportunity to approximate — there is nothing to approximate over
twelve points that a brute-force scan would not also find. What this experiment measured is
agreement on exact cosine ranking, **not** approximate-nearest-neighbour behaviour under load. It is
precisely at scale — where HNSW starts trading recall for latency, and where Atlas's own vector index
does the same tradeoff internally — that the two engines could diverge, and this experiment cannot
speak to that question at all. "Identical" describes this twelve-chunk corpus; it must not be read as
"equivalent at any scale."

## The stated asymmetry (a locked decision, recorded here, not relitigated)

The Qdrant side ran **dense-only**. Qdrant has no native BM25 equivalent, and bolting on a sparse
encoder to give it a lexical signal would have introduced a second variable into the comparison,
producing a worse comparison rather than a fairer one. Consequently `qdrant-vector` vs `vector` is
apples-to-apples and is the comparison that carries weight; `qdrant-vector` vs `hybrid` is
challenger-vs-production-configuration, and `hybrid`'s MRR lead (0.667 vs 0.648) partly reflects the
lexical signal Qdrant was never given a chance to contribute. This asymmetry was a design choice made
before the numbers came back, not a post-hoc excuse for a tie.

## Why the decision survives the numbers being a tie

Adopting Qdrant would mean a second datastore to run, back up, and secure for zero measured
retrieval gain over what Mongo already does inside the single store ADR-0002 chose. `RetrievalStore`
(`src/providers/retrieval/retrieval-store.interface.ts`) is search-only; nothing in this benchmark
built a write path, so production adoption would additionally require dual-write in ingestion — the
benchmark deliberately populates Qdrant out-of-band from already-embedded rows precisely to avoid
building that write path for an experiment that might not justify it. And Mongo keeps BM25 fusion
available inside one engine, which the dense-only constraint above demonstrates Qdrant cannot match
without extra machinery of its own.

## Known bounds

1. **The 12-chunk corpus cannot exercise approximate search.** See "The bound that must carry as much
   weight as the result" above — this is the single most important limitation of what was measured
   and is restated here as a checklist item deliberately, not only in prose.
2. **The comparison is dense-only on the Qdrant side.** `qdrant-vector` never saw a lexical signal;
   see "The stated asymmetry" above. A future Qdrant sparse-vector or hybrid configuration would be a
   different, not-yet-measured comparison.
3. **No write path was built or measured.** `populateQdrantCollection` populates the benchmark
   collection from rows Mongo already holds and already embedded; nothing here measures ingest
   latency, dual-write consistency, or failure handling for a Qdrant-backed write path, because no
   such path exists in this codebase.
4. **Resident memory was measured only at idle and immediately post-benchmark on a 12-chunk
   collection.** ~63 MiB idle, ~68 MiB after the benchmark ran, against the compose service's 256 MiB
   `mem_limit`. That headroom is not evidence of headroom at a larger corpus size — see bound 1.
5. **The retrieval-mode tuning constants this comparison depends on are hand-duplicated, not shared**
   (ADR-0007 known bound 4, restated here because it applies to this comparison too):
   `retrieval-modes.ts` copies `mongo-hybrid.store.ts`'s index names, RRF `k`, and pipeline weights
   verbatim. A future change to those constants in the production store must be mirrored by hand or
   the `vector`/`hybrid` rows in this table silently stop reflecting production behaviour.

## Consequences

**Good.** ADR-0002's deferred comparison is now closed with a measured number rather than an
argument. Qdrant stays available as profile-gated benchmark infrastructure — a real container behind
`docker compose --profile qdrant up -d` — for the day one of the revisit triggers below actually
fires, rather than having to be re-built from nothing. `@qdrant/js-client-rest` staying a
devDependency means this decision cost nothing in the runtime image regardless of outcome.

**Costs.** A second retrieval implementation exists now purely for this comparison
(`eval/qdrant/*`), duplicating field shapes and tuning assumptions from both `mongo-hybrid.store.ts`
and `retrieval-modes.ts` (known bound 5) and needing to be kept in sync by hand if either changes.
The comparison also cost real engineering surface — point-id reformatting, payload shaping, a second
compose service — for a benchmark whose conclusion is "do not adopt this," which is the correct
outcome to be able to reach cheaply but is still surface that has to be maintained if this ADR is
ever revisited.

**Deferred, deliberately — the concrete triggers that would justify revisiting this decision:**

1. **A corpus large enough for ANN approximation to matter.** This experiment's 12-chunk corpus
   cannot distinguish Qdrant's HNSW behaviour from Atlas's own vector index at any scale — see the
   bound above. A production-sized corpus is the first thing that could produce a different number.
2. **A latency requirement Atlas Local cannot meet.** Nothing in this comparison measured latency
   under load; if a future requirement names a latency budget the single-store path cannot hit, that
   is a reason to re-run this comparison with latency as a measured axis, not just recall/MRR.
3. **A need for a vector-search feature Atlas lacks.** This ADR evaluates retrieval quality and
   operational cost on the feature set both stores already have; it says nothing about a future
   requirement (e.g. a Qdrant-specific indexing or filtering capability) that Atlas's `$vectorSearch`
   does not offer at all.

None of these triggers has fired as of this ADR. Until one does, the second-datastore cost named
above is not worth paying for a measured tie.

## Interview framing

> I closed a question ADR-0002 deliberately left open, and I want to be precise about what "closed"
> means here. `qdrant-vector` came back numerically identical to Mongo's own `vector` mode — same
> recall, same MRR, to the metric. That is a real result, not a wash, but the corpus it was measured
> against is twelve chunks, small enough that neither engine is doing anything but exhaustive search.
> Qdrant's whole reason to exist — approximate nearest-neighbour search that trades a little recall
> for a lot of speed at scale — never got exercised at all. I'd rather say plainly that this
> experiment measured agreement on exact ranking, not equivalence at scale, than let a clean table
> imply more than it proved. The decision to keep Mongo doesn't rest on the tie alone; it rests on the
> tie plus the fact that adopting Qdrant would mean a second datastore, a write path that doesn't
> exist yet, and giving up the one-engine BM25 fusion Mongo already gives us for free — for zero
> measured gain. I also want to flag the comparison's one built-in asymmetry: Qdrant ran dense-only,
> because it has no native BM25 and bolting one on would have made this a worse comparison, not a
> fairer one. That's a locked, deliberate choice, not something this ADR is quietly working around.
