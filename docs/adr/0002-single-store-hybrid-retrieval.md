# ADR-0002 — Single-store hybrid retrieval on MongoDB, with a verified go/no-go

- **Status:** Accepted — verified against a running server, not inferred from docs
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

Grounded answers need both lexical and semantic recall. A figure like "5.25%" or a proper noun is
found by exact term matching; "how aggressive was the pricing" is found by embedding similarity.
Using only one of them loses a whole class of question.

That leaves where the vectors live:

1. **MongoDB alone** — `$search` (BM25) and `$vectorSearch` in one store, fused by `$rankFusion`.
2. **MongoDB + a dedicated vector database** (Qdrant, Weaviate) — vectors there, provenance here.
3. **MongoDB + application-side fusion** — two queries, reciprocal-rank fusion in our own code.

The deciding constraint is provenance, not ranking quality. Every retrieved chunk must carry its
document version, sha256 and locator, and every query must be filterable by tenant. In a split
store that means either duplicating provenance into the vector database (two things to keep
consistent) or a second round-trip to rehydrate it (and no way to filter before ranking).

## Decision

**Single-store MongoDB**, using server-side `$rankFusion` over a `$search` pipeline and a
`$vectorSearch` pipeline, with application-side RRF retained behind a `RETRIEVAL_FUSION` config
flag as a fallback.

Local development runs `mongodb/mongodb-atlas-local`, not the plain `mongo` image, because the
plain image has no search process at all.

## The part that mattered: verifying before designing on it

`$rankFusion` is newer than the rest of the aggregation surface, and accepting a `$vectorSearch`
stage *inside* an input pipeline is newer still. Building the retrieval layer on a documented
feature without running it is how a demo dies in the week it matters.

So the go/no-go probe was written to reject **both** wrong answers, which is the part worth
copying:

- **False no-go.** `$rankFusion` against a collection with no search indexes errors out even on a
  server that fully supports it. A probe that skips index creation concludes "unsupported" and
  sends you down a rewrite you did not need.
- **False go.** A `$rankFusion` whose inputs are only `$search`/`$match` succeeds on older servers.
  A probe that omits `$vectorSearch` concludes "supported" and the failure surfaces later, deeper.

The probe therefore creates both index types, polls `listSearchIndexes` until each reports
queryable, seeds deterministic vectors, fuses a `$search` pipeline with a `$vectorSearch` pipeline,
and runs a `$search`-only control so any failure can be attributed to the right cause.

**Result — GO.** Server 8.3.4. Fusion works with a `$vectorSearch` input, weights are honoured, and
`scoreDetails: true` returns per-pipeline `{inputPipelineName, rank, weight, value}` with `"NA"`
where a pipeline did not return the document. The server's own description string confirms the
formula: `sum(weight * (1 / (60 + rank)))` — k=60.

The application-side fallback mirrors k=60 exactly, so switching fusion modes changes where the
work happens and not what the ranking means. That is what makes the two comparable in an
experiment rather than merely both "hybrid".

## Consequences

**Good.** One consistency model, one filter language, provenance adjacent to the vectors, and
tenant filtering applied before ranking rather than after. `scoreDetails` gives per-pipeline ranks
for free, which is most of an explainability panel.

**Costs.** Local development requires the Atlas Local image and roughly 2GB of RAM — a heavier
prerequisite than `mongo:latest`. Search indexes are not Mongoose indexes and must be created
explicitly in a migration, which is easy to forget. A concrete image tag is pinned rather than a
floating major, because a corpus and its index definitions should not change under the eval
harness.

**Deferred, not rejected.** A dedicated vector database remains a live option. The retrieval
interface is a single port, and the eval protocol varies only a `RetrievalConfig {mode, k, weights}`
against a frozen corpus, chunking and embedding set — so a competing store can be measured on the
same ground rather than argued about.

**Rejected for now.** A reranking stage. `rerank-2.5` is available, but on a corpus of roughly a
thousand chunks hybrid retrieval is already near-exhaustive and a cross-encoder adds a network
round-trip per query for small marginal precision. Revisit if the eval metrics show a precision
deficit — measure first, then add the stage.

## Interview framing

> I didn't take the documentation's word for it. The probe was built to fail loudly in both
> directions, because a false no-go and a false go are different bugs and a smoke test that can't
> tell them apart isn't evidence. It came back GO on 8.3.4, and the server's own score description
> confirmed k=60 — which is why the application-side fallback uses the same constant. Otherwise the
> two paths would rank differently and I'd have no way to compare them.
