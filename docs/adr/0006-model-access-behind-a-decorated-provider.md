# ADR-0006 — Model access behind one decorated provider interface

- **Status:** Accepted — verified against the live Anthropic and Voyage APIs
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

Model calls need, in every case: a schema-validated result, token and cost accounting, a spend
ceiling, tracing, and — for the evaluation harness — deterministic replay. Calling the vendor SDK
from feature code means each of those is re-implemented per call site, inconsistently, and the eval
harness has nowhere to intercept.

## Decision

One `ModelProvider` port, one `EmbeddingProvider` port, and cross-cutting behaviour added by
decorators rather than by inheritance or flags:

```
TracingModelProvider( CachingModelProvider( AnthropicModelProvider ) )
```

Each decorator does one thing and composes. The eval harness's replay cache and the future model
router are the same pattern applied at the same seam — which is the point: routing is not a new
mechanism to design later, it is another decorator.

### Structured output — a decision changed by evidence

The plan specified forcing a tool call whose `input_schema` carries the answer schema. That was the
established trick. Native **Structured Outputs** (`output_format`) is now generally available and
grammar-constrains generation directly, which is what this actually needs: the final answer is a
JSON object matching a discriminated union, not a tool invocation. Switched. Forced tool use stays
only where a call genuinely chains tools.

Recorded here as a plan decision overturned by research rather than quietly edited, because "we
checked what shipped recently" is the interesting part.

### zod, as a scoped exception

The repo's convention is that zod is env-validation only — requests use class-validator, responses
class-transformer. The provider layer breaks that deliberately and narrowly: the output schema must
convert to JSON Schema for `output_format` and be reused unchanged by the eval harness, and
class-validator cannot express either. Scoped to `src/providers/**` and the model contracts, with
the reason stated in the interface file so it does not read as drift.

Specifically `zod/v4`, because the SDK's `zodOutputFormat()` helper requires a v4 schema instance
and v3/v4 instances are not interchangeable at runtime.

### Retries: exactly one, and not the SDK's

The Anthropic SDK already retries transient failures twice by default with backoff honouring
`retry-after`. Adding a retry loop on top would silently multiply attempts — and therefore spend —
on every rate-limit. So transport retries stay the SDK's job, configured through `maxRetries`, and
the provider's single retry is for **schema-validation failure only**, feeding the validation
errors back to the model. That is a different failure class, and after one attempt it throws a
typed error rather than returning unvalidated output. The unit test asserts the retry count is
exactly one, because "one retry" is the invariant, not an implementation detail.

### Sampling cannot be pinned — reproducibility moves to the replay cache

The plan pinned `temperature: 0` per `taskClass` to narrow the run-to-run variance in prose fact
extraction, measured on a live eval run at 8 facts from `valuation-memo.pdf` on one call, 2 on the
next, from byte-identical input. A later live call rejected that: `400 invalid_request_error:
\`temperature\` is deprecated for this model` — the configured model tier does not accept the
parameter at all, in either direction. Removed from the request entirely, along with the
now-dead `sampling-params.ts` table, its resolver, and its inclusion in the cache key
(`cache-key.util.ts`, `caching-model.provider.ts`): a cache key field for a parameter the request
never carries no longer discriminates fixtures, it only misleadingly implies it might.

The consequence is real and stays real: prose fact extraction still varies run to run, and with
temperature unavailable there is no provider-level lever left to suppress that. What this decision
changes is where reproducibility has to come from — not from constraining sampling at call time,
but from the record/replay cache (`CachingModelProvider`) already in the decorator stack for the
eval harness. That is the whole reason the decorator earns its place here: it is the only
determinism lever this model tier leaves available. To be precise about what it buys — replaying a
recorded response makes a given **eval run** reproducible byte-for-byte, because the same fixture
is served every time. It does not make the **system** deterministic: a live call still returns a
different fact set on different runs, same as before. Replay sidesteps that variance for
evaluation; it does not eliminate it as a live behaviour.

### Budget caps fail closed

A request carrying `maxCostUsd` is refused **before** the call when the worst-case estimate exceeds
it, rather than being silently truncated to fit. The estimate is deliberately worst-case, so it can
only over-refuse — a gate that guesses low is not a gate. The test asserts no request was issued.

### Cost accounting

One price table, so a price change is a one-line edit. It prices 5-minute and 1-hour cache writes
separately (×1.25 and ×2.0 on the input price) rather than lumping `cache_creation_input_tokens`
into a single bucket — which would misprice every cached run once prompt caching is enabled, in the
direction of under-reporting.

## Consequences

**Good.** Feature code never imports a vendor SDK. Swapping models, adding a router, or replaying
cached responses are all changes at one seam. Cost is measured rather than estimated: a request
carries `usage` and a computed `costUsd` from the same call that produced the answer.

**Costs.** Indirection — reading a model call means reading three files. The decorator stack is
assembled by hand in a factory because the decorators take their inner provider positionally, which
Nest's reflection-based `useClass` cannot resolve.

**Verified live.** Structured output parsed correctly; `usage in=323 out=30`; `costUsd` **0.001419**,
matching `323×$3/MTok + 30×$15/MTok` exactly. Voyage returned 2×1024d vectors, with the width
asserted against `EmbeddingProvider.info.dimensions` — the index build reads that field, so a
mismatch would produce an index that silently never matches.

**Deferred.** Prompt caching is not enabled yet; the pricing multipliers exist so that turning it on
is a config change rather than a cost-accounting rewrite. No model router in slice 1 — one model,
measured, before adding a routing decision to defend.

## Interview framing

> Two things I'd point at. First, the SDK already retries twice, so the provider's own retry is
> strictly for schema-validation failure — stacking retries on a rate-limited paid API is a spend
> bug that looks like resilience. Second, the cost table prices five-minute and one-hour cache
> writes separately. Lumping them is the obvious shortcut and it under-reports every cached run,
> which is the worst direction for a number you're using to make routing decisions later. Third,
> this model tier rejects `temperature` outright, so sampling can't be pinned — reproducibility for
> the eval has to come from the replay cache, not from constraining generation. That's a narrower
> claim than "the system is deterministic": replay makes a recorded eval run reproducible; the live
> model call underneath it still varies.
