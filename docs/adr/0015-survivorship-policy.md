# ADR-0015 — Survivorship policy: a deterministic winner proposal, never an auto-resolution

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

Conflict detection (`detect-conflicts.ts`) already tells a user that two documents disagree on the
same entity, metric, and period. It has no opinion about which one is right. That gap, not the
detection itself, is what a buyer actually needs closed: without an agreed rule for which source
outranks another, "these two numbers disagree" is a dead end a human has to resolve entirely from
scratch every time, with no help from the system that noticed the disagreement in the first place.

Two shapes for closing that gap were on the table:

1. **Auto-resolve** — pick a winner and write it back as the accepted fact, the same way the model's
   own extraction pipeline writes facts today. Fastest to demo, and wrong for this product
   specifically: ADR-0009 built durable human approval gates because the product's whole trust
   story is that a human, not the model or a heuristic, is the one who decides a consequential
   outcome. A deterministic rule is more defensible than a model guess, but "more defensible" is
   still not "the human who owns this deal agrees with it" — and a survivorship rule that silently
   overwrote a fact would be indistinguishable, from the outside, from the exact failure mode the
   approval gates exist to prevent.
2. **Propose, and stop there.** Compute a winner deterministically, state the rule that fired and
   why, and hand that to whatever surfaces conflicts to a human — who still clicks accept or
   rejects it. Slower to reach a resolved state, and the only shape that keeps the trust model
   intact: the system's job is to make the human's decision fast and well-informed, not to make the
   decision.

This ADR is (2). `resolve-conflict-policy.ts` is a pure function: given the conflicting facts and a
per-metric policy, it returns a proposed winner, the rule that produced it, and an explanation a
reviewer can check against the evidence — or it declines.

## Decision

### Policy proposes, human disposes

`resolveConflictPolicy` never writes anything itself; `ConflictsService` is its only caller, and it
uses the function two ways. `list()` recomputes the proposal fresh on every read — never persisted,
so a stored proposal cannot go stale against a since-changed `authorityOrder` or `sourceClass` — and
exposes it on the response DTO as `proposedWinnerFactId`/`ruleFired`/`explanation`. `recordResolution`
recomputes the same proposal to record which rule fired, alongside whatever outcome a human already
supplied. Keeping the write gated on a human-supplied `outcome` is what keeps "propose" from quietly
becoming "decide": nothing in this call chain sets `status: 'resolved'` or a conflict's
`winningFactId` except a request that already carries a human's decision.

### Fails closed to `ruleFired: 'none'`

A wrong proposal is worse than no proposal — it is shown to a human deciding which figure to trust,
and a confidently wrong suggestion is more dangerous than an honestly absent one. The function
returns `'none'` (and no `proposedWinnerFactId` — enforced by the return type being a discriminated
union, not just a runtime convention) whenever the configured policy or the input facts do not
unambiguously determine a winner: no `authorityOrder` configured, an internally contradictory
`authorityOrder`, a candidate whose source class the order does not cover, an authority tie with a
missing `observedAt` on either side, an authority tie with identical `observedAt` values, or an
authority tie whose recency gap does not exceed the configured staleness window. Every one of these
is proven by its own test in `resolve-conflict-policy.spec.ts`.

### A contradictory `authorityOrder` is caught before it can be silently exploited

`authorityOrder` is a plain array; rank is position. Nothing stops a caller from constructing
`['crm-export', 'memo', 'crm-export']`, which claims `crm-export` is simultaneously rank 0 and rank
2. A rank lookup built the obvious way — build a map from class to its first-seen index — would
resolve that config without complaint and hand back a confident answer built on an order that does
not actually have a coherent claim about `crm-export`'s rank at all. The function instead validates
the whole `authorityOrder` for duplicate entries before looking at a single fact, and the negative
control in the spec constructs exactly this config to prove the naive lookup's failure mode is
closed, not merely untested.

### `'unclassified'` means no authority information, not the lowest rank

`Document.sourceClass`'s own doc comment already states this (`document.schema.ts`): `'unclassified'`
means nobody has said what kind of source a document is. Treating it as the lowest rank would still
be inventing an ordering — it asserts "less authoritative than every classified source," which is a
claim about a document the data never made. `resolveConflictPolicy` refuses on any candidate whose
`sourceClass` is `'unclassified'`, unconditionally, even if a policy's `authorityOrder` explicitly
lists `'unclassified'` as a rank — a caller including it is still asking the function to treat
"nobody classified this" as if it were classification, and the function declines to do that on the
caller's behalf.

### A missing `observedAt` blocks recency; it is never defaulted

`ExtractedFact.observedAt` is optional by design — absent means nobody recorded when the value was
observed, not "assume it is old" and not "assume it is as fresh as `createdAt`." Recency only ever
runs as a tie-breaker among facts already tied on authority, and only when every tied fact carries
an `observedAt`. A missing timestamp on one of the tied facts stops the tie-break entirely rather
than falling back to any substitute value, because a fabricated observation date would let a recency
rule fire on evidence that never actually carried one.

### The staleness window is a strict threshold, not "any difference wins"

`stalenessWindowMs` is the minimum gap between two authority-tied facts' `observedAt` values for the
newer one to count as meaningfully fresher. A gap at or under the window resolves to `'none'` — two
observations a few hours apart are not a meaningful recency signal even if their timestamps are not
byte-identical, and treating any nonzero gap as decisive would make the rule's output depend on
clock precision rather than on an actual claim about which observation is stale.

## Known bounds

1. **This ADR does not define what `authorityOrder` or `stalenessWindowMs` should be for any real
   metric.** Both are consumed as this function's own input type; `metric-ontology.ts` is where a
   real metric supplies them, and `ConflictsService.computeConflictProposal` is the live caller that
   reads them from there. This ADR covers only the resolution function's own behavior, not whether
   any given metric's configured order or window is the right one.
2. **An authority tie among three or more facts breaks on the closest gap, not the widest.** The
   fresher fact wins only if it clears the staleness window against the *next-most-recent* tied
   fact, not against the oldest. This is deliberate — clearing the window against the closest
   competitor is sufficient to clear it against every fact further behind — but it means the
   proposed winner can change if a new, closely-timed fact is added to an existing tie, even though
   the actual freshest fact does not change.
3. **Recency compares exact instants.** Two facts observed on the same calendar day at different
   times are not a tie unless their `observedAt` values are identical to the millisecond; the
   staleness window, not date-only comparison, is the mechanism that absorbs "these are close
   enough to call same-day."

## Consequences

**Good.** The proposal is deterministic and reproducible — the same facts and policy always produce
the same `ruleFired` and the same explanation, so a reviewer can re-derive the reasoning rather than
trust a black box. Every `'none'` branch is independently proven, including a negative control that
fails against a plausible-looking but wrong implementation, not just against the one actually
shipped. Nothing in this change can write a resolved fact, because nothing in this module writes
anything.

**Costs.** `resolve-conflict-policy.ts` sits outside the coverage gate (`collectCoverageFrom` only
measures `*.service.ts` and `shared/utils`), so its correctness rests entirely on the discipline of
covering every branch by hand rather than on a build failure catching a gap. A second per-metric
configuration surface (`authorityOrder`, `stalenessWindowMs`) now has to be supplied coherently by
whatever defines it — an incoherent one does not crash, it just makes every conflict for that metric
resolve to `'none'`, which is safe but silent unless something surfaces the reason to a human.

**Deferred, deliberately.** Revisiting auto-resolution — letting a sufficiently confident proposal
apply itself without a human clicking accept — was left out of scope rather than designed around.
Doing it safely would need at least: an audit trail distinguishing an auto-applied resolution from a
human-approved one, a way to reverse an auto-applied resolution as easily as a human decision can be
revisited today, and very likely a per-tenant or per-metric opt-in rather than a global default —
none of which exists yet, and none of which this ADR tries to anticipate the shape of.

## Interview framing

> The function proposes a winner; it never decides one. That split isn't incidental — ADR-0009 built
> durable approval gates specifically so a human, not a heuristic, owns consequential decisions, and
> a survivorship rule that wrote back a winner on its own would quietly be the same failure mode in a
> different module. The part I'd flag first: `'unclassified'` is never ranked, not even last, because
> ranking it anywhere is still inventing information the data never recorded — the schema already
> says as much, and the policy just refuses to contradict it. Second: the negative control matters
> more than the positive tests here. A rank lookup built the obvious way resolves a contradictory
> `authorityOrder` without complaint; the spec constructs exactly that contradiction and asserts the
> function declines, which is the only way to know the fail-closed behavior is real and not just
> documented.
