# ADR-0013 — Provider-neutral citations over vendor citation APIs

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

ADR-0004 established `GroundingGateService` as the mechanism that decides whether an `answered`
outcome is trustworthy: it checks every citation's `chunkId`/`docVersionId` against what was
actually retrieved, checks the cited `quote` against the chunk's real text, and checks every number
a claim states against extracted facts or chunk text. That check runs entirely inside this
application, against `AnswerContract` — a schema this codebase owns — and depends on nothing the
model vendor has to expose beyond "a JSON object with a quote and a chunk id in it."

Some vendors also ship their own citation feature. Anthropic's Citations API lets a request mark
source documents so the model's response carries vendor-generated citation spans tied to those
documents. That looks, at first glance, like it could replace or strengthen the hand-rolled
contract. This step (`OpenAiModelProvider`, `openai-model.provider.ts`) is what makes the question
concrete rather than hypothetical: the platform now serves answers through `ModelProvider`
implementations for two materially different backends — a hosted vendor API and, through the same
port, an OpenAI-compatible endpoint that can be a self-hosted vLLM or Ollama server with no vendor
citation feature of any kind. A decision about citations has to hold across all of them, not just
the one that happens to have shipped a citations product first.

## Decision

The provider-neutral citation contract (`AnswerContract`'s `claims`/`citations` shape) plus
`GroundingGateService`'s deterministic verification (ADR-0004) stays the only mechanism that
determines whether a citation reaches a caller as trustworthy. Vendor citation APIs are evaluated —
kept under active review as the market for them develops — but not adopted into the served answer
path.

### Adopting a vendor citation API would re-introduce the dependency the provider seam exists to remove

ADR-0006 built one `ModelProvider` port precisely so feature code never depends on a vendor SDK, and
so a call site works unchanged regardless of which implementation `MODEL_PROVIDER` resolves to. A
vendor citation feature is not expressible behind that port today: it is not a shape in
`ModelRequest`/`ModelResult`, and no equivalent exists on the OpenAI-compatible side this step just
enabled. Routing citations through it would mean one of two things, and both are worse than the
status quo — either the served answer's trustworthiness depends on which `MODEL_PROVIDER` a
deployment happens to have selected (correct citations behind Anthropic, unverified prose behind
everything else), or the deterministic gate has to stay as a fallback for every non-Anthropic
provider anyway, in which case the vendor feature bought nothing but a second code path to
maintain. Both outcomes are exactly the single-vendor coupling the provider seam was built to make
impossible.

### The deterministic gate is the product's differentiator, not a stopgap a vendor feature supersedes

A vendor citation feature is the model annotating what it says it drew from. `GroundingGateService`
independently verifies that annotation against bytes this application actually retrieved and handed
to the model — retrieval containment, quote containment, and numeric support are all checks against
data outside the model's control, not inside it. A citation API answers "what does the model claim
it cited"; the gate answers "is that claim actually true of the evidence this request retrieved."
Replacing the second with the first would trade a verification step for an attribution step — a
narrower guarantee dressed as a stronger one, in the direction this codebase's other citation
decisions (ADR-0004 bound 5's closed `insufficient_evidence`/`conflicting_evidence` channels) have
consistently refused to accept.

### Scope of "evaluates"

Evaluation means the eval harness (`eval/`) may record a vendor citation API's output alongside the
gate's own verdict for comparison, and this ADR may be revisited on what that comparison shows.
Nothing in the served path — `SynthesisService`, `GroundingGateService`, `groundingCheck` — reads a
vendor citation field, and no `ModelRequest`/`ModelResult` shape changes to carry one. There is no
half-wired vendor-citations code in the served path today; this ADR is what keeps it that way until
one of the triggers below is met.

## Rejected alternatives

- **Route Anthropic-served answers through the Citations API and keep the deterministic gate only
  as the non-Anthropic fallback.** Rejected: two different trust models for the same product
  guarantee, verified to two different standards, is not a state this codebase can document or test
  to one bar — and a caller cannot tell from the response alone which guarantee an answer actually
  received.
- **Use a vendor citation API as a non-authoritative input the gate consults alongside its own
  checks** (for example, treating vendor/gate agreement as a confidence signal). Rejected for now:
  it adds a provider-conditional code path to the gate without removing any of the gate's own
  checks, and there is no measured gap in the gate today (ADR-0004's known bounds are documented,
  not evidence that a citation API would close any of them) that this would demonstrably fix.

## Revisit triggers

Concrete conditions under which this decision is worth reopening, not a commitment to reopen it on
a schedule:

1. **An OpenAI-compatible or self-hosted equivalent ships.** If a structurally verifiable citation
   primitive — not merely a prompted convention — becomes available broadly enough behind
   `ModelProvider` that it could be normalized at the port rather than bound to one vendor, the
   single-vendor-coupling objection above no longer applies and adoption is worth designing.
2. **A measured gate gap that a vendor signal would close.** ADR-0004's known bounds (reasoning
   verification, word-number blindness, cross-touch on identical numeric values) are the standing
   list of what the gate does not catch. If a future eval run or live incident shows one of those
   bounds is better closed by a vendor citation signal than by a fix to the gate itself, that is a
   forcing example, not a hypothetical — see ADR-0004's own framing of what counts as one.
3. **The product commits to serving only one vendor's models.** That is a strategic decision outside
   this ADR's scope, but if it happens, the reason a provider-neutral contract matters here goes
   with it, and this decision needs explicit revisiting alongside that one — not a quiet bypass of
   it.

## Consequences

**Good.** Citation trustworthiness means the same thing regardless of which `ModelProvider` served
the answer — a deployment running entirely against a self-hosted OpenAI-compatible model gets the
identical guarantee a deployment running against Anthropic gets, because neither depends on a
vendor feature the other lacks. The gate's checks stay auditable and testable in this codebase
without a vendor's citation-matching behavior as an opaque dependency.

**Costs.** The hand-rolled contract and gate is more code to build and maintain than pointing at a
vendor feature that already exists, and every new evidence type (a future document format, say)
extends the gate's own checks rather than inheriting whatever a vendor's citation API happens to
support for that type.

**Deferred.** No eval-harness comparison branch exists yet to gather the evidence trigger 2 above
would need — recording a vendor citation API's output alongside the gate's verdict is a real next
increment, not designed here because there is no current signal that the gate is under-catching
anything a citation API would catch instead.

## Interview framing

> The forcing move here was adding a second `ModelProvider` — once a self-hosted, vendor-free
> endpoint is a legitimate deployment behind the same port, a citations feature that only one vendor
> ships stops being a nice-to-have and becomes a fork: correct behavior on one backend, degraded
> behavior on every other one behind the identical interface. That's the exact coupling the provider
> seam in ADR-0006 exists to prevent, so adopting it for the core path would have undone that
> decision through the citations feature rather than the model call itself. The second thing I'd
> point at: a vendor citation API and this codebase's grounding gate are not the same guarantee even
> when both are available — one is the model attributing its own output, the other independently
> verifies that attribution against bytes the application actually retrieved. Swapping the second for
> the first would have been a real regression dressed as an upgrade.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the deterministic gate this decision
  keeps as the sole verification mechanism, and the known bounds trigger 2 above measures against.
- `docs/adr/0006-model-access-behind-a-decorated-provider.md` — the provider seam whose
  single-vendor-coupling argument this decision extends to the citations question.
