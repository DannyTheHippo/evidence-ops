# ADR-0022 — Operator-authored resolution rules, tenant-renamed measures, and the hindsight check that scores both

- **Status:** Accepted
- **Date:** 2026-08-19
- **Supersedes:** —

## Context

`METRIC_ONTOLOGY` (`metric-ontology.ts`) has always been the sole source of survivorship
behaviour: which source class outranks which for a given metric, and how long an observed value
stays current. Three of its eight metrics ship with `authorityOrder`, four with
`stalenessWindowMs`, and only two — `net_operating_income`, `tenant_occupancy_share` — carry both.
The rest is a blank the code author left for the reason each metric's own comment states (a
negotiated lease term has no source-class authority a practitioner would agree on; a closed sale
price does not decay). That blank was previously permanent: changing it meant shipping code. An
operator running this system for a real client has opinions the code author cannot — which
property-management export they trust, which comps spreadsheet compiler is careful — and no way to
act on them.

Two more requests followed the same shape. `ConflictResolutionOutcome`'s `resolved`/`rejected`
history had no way to say whether the survivorship policy, as currently configured, would have
picked the same fact — an operator authoring a rule had no feedback loop telling them whether it
was any good. And the ontology's own labels are code-author prose ("Net Operating Income"), fixed
regardless of what the client calls the same figure internally.

## Decision

### `metric_policies`: whole-row override, not a taxonomy of its own

`migrations/0027-metric-policies.ts` creates `metric_policies` (tenantId, metric, authorityOrder?,
stalenessWindowMs?). `MetricPoliciesService.resolveForTenant(tenantId)` folds a tenant's authored
rows over `METRIC_ONTOLOGY`, one entry per metric the ontology defines, into the
`Map<MetricId, SurvivorshipPolicy>` every consumer already expected. An authored row replaces a
metric's **whole** policy — `authorityOrder` and `stalenessWindowMs` together — never merged field
by field, so an operator who clears a staleness window on a second `PUT` stays distinguishable
from one who never touched the row. A tenant with no authored rows resolves to exactly what a
direct `metric?.field ?? default` lookup against `METRIC_ONTOLOGY` already produced — asserted in
`S1`'s acceptance test, including every explanation string the resolver produces, not merely the
resolved values.

`resolve-conflict-policy.ts` — the pure function every proposal ultimately calls — is **not
modified**. Its own spec passes unmodified against the new resolver, which is the proof the
authoring surface composes with existing behaviour rather than replacing it.
`UpsertMetricPolicyRequestDto` rejects a duplicate rank and `'unclassified'` at write time — both
would otherwise pass a naive `@IsIn` check and make `resolveConflictPolicy` silently refuse to
propose a winner the first time the row mattered, at read time, with no error anywhere. Rejecting
them at the moment an operator can still see why is strictly better than a proposal that quietly
stops firing.

### `tenant_metrics`: labels are tenant-owned, detection is not

`migrations/0028-tenant-metrics.ts` creates `tenant_metrics` (tenantId, metricId, label). An admin
may rename a code-ontology metric's display label or add a wholly new catalog entry; neither
touches `METRIC_ONTOLOGY`. **`tolerance` and `unit` are deliberately not editable, and carry no
field on this collection to make editable** — they decide what counts as a disagreement between
two facts. Fact extraction and conflict detection both read `METRIC_ONTOLOGY` directly and never
this collection, so changing either would silently redefine, after the fact, which of a tenant's
already-detected conflicts should have existed at all — and every backtest that has ever scored a
resolution against them would retroactively describe a different question than the one it actually
answered. A label is presentation; a tolerance is a claim about the world. This ADR keeps the first
editable and the second fixed for that reason, not because loosening it was technically harder.

### The hindsight check: `unscorable` has to be its own gate, not a `silent` result

`ResolutionBacktestService.run(tenantId)` replays the tenant's **current** survivorship rules over
every conflict that ever reached a `resolved`, `rejected`, or `timed_out` resolution attempt (the
three outcomes a human decision can produce; `superseded` — `DocumentsService.remove`'s own
machine bookkeeping when a deletion leaves a conflict too small to stay open — is excluded outright
rather than scored, since no human ever decided a winner there). Each conflict scores `agreed`,
`disagreed`, `silent`, or `unscorable`.

The `unscorable` gate runs **before** `resolveConflictPolicy` is ever called, for a reason that is
not cosmetic: a starved candidate set — no recorded winner, or a fact deleted since resolution —
makes the policy return `ruleFired: 'none'`, indistinguishable from a genuine `silent` verdict
unless the check happens first and the call is skipped entirely. The two states answer different
questions. `silent` means "your rule has no opinion here, consider authoring one." `unscorable`
means "we cannot tell you anything about this one" — the client's own stated acceptance criterion
for this feature turns on keeping them apart. The second gate is reachable, not hypothetical:
`DocumentsService.remove`'s conflict update is `status: 'open'`-scoped
(`documents.service.ts:502-519`) while its four fact `deleteMany` calls are not
(`:522-548`), so a document deletion can remove facts a `resolved` conflict's `factIds` still
names. `agreementRate` is `agreed / (agreed + disagreed)`, `null` — never `0` — when nothing was
scorable, because `0` asserts the rule always disagreed, a claim this state has no basis for.

### `ResolutionRulesPage`: authoring, not a dashboard

The SPA's 16th page, gated at route level by `RequireAdmin` — `/audit-events` is the precedent, and
a wholly admin-only page gates there rather than duplicating a two-flag check on every control
inside it. The rules table lists all eight ontology metrics — an authoring surface has to show a
metric with no row at all, or there is no way to author its first rule — rendering each authored
`authorityOrder` as `a › b › c`, or exactly `No order configured` when absent. That absence is a
real state the resolved policy treats as "no opinion" (the same state `resolveConflictPolicy`
reports as `ruleFired: 'none'`), so a blank cell would misrepresent it as unset-and-irrelevant
rather than unset-and-meaningful.

Editing happens in `resolution-rules/RuleEditorDialog.tsx`, split out of the page the same way
`pages/data-room/` splits `DocumentList`/`DocumentDetail` — the table stays one scannable line per
metric, the native `<dialog>` supplies the focus trap a multi-step keyboard reorder needs, and
there is one live region per dialog rather than one per row. The reorder control is fixed-membership:
all five rankable source classes, always, seeded in the authored order with any left-out classes
appended in the server's own canonical order — a chevron-only, no-drag-and-drop control cannot
express adding or removing a class, and seeding only the authored subset would make authoring a
metric's first rule impossible (an empty list has nothing to reorder). Saving always submits the
full five; the `stalenessWindowMs` the dialog never edits rides along unchanged on every save,
because the server replaces a policy's whole row on `PUT` — omitting it would silently clear an
existing staleness window the operator never touched.

Two requirements make the control actually usable with a keyboard rather than merely operable by
one:

1. **The live region announces the result, not the click** — `"{class} moved to position N of M"`
   — because a screen-reader user pressing a move button needs to hear where the item landed, not
   that a button was pressed.
2. **Focus survives a move that disables the button just pressed.** Moving an item to either end
   disables that direction's button; without an explicit restore, focus falls to `<body>` and
   keyboard reordering dies mid-task. A `useEffect` keyed on the reordered list re-focuses the
   moved class's button in the direction just used, falling back to its sibling on the same row
   when that button is now the disabled one.

`IconButton` gained `forwardRef` to make the second requirement possible at all — a caller has to
reach the actual DOM node to move focus onto it, which an unforwarded ref cannot do. `IconChevronUp`
is the cycle's one new icon; `icons.test.tsx` enumerates `Object.entries(Icons)`, so it is covered
without a dedicated test.

The hindsight table renders every backtest result with a verdict-to-tone map that treats
`disagreed` as verification-grade, not merely informational: `agreed → verified`, `disagreed →
rejected` (a rule contradicting a human decision is exactly the kind of finding the octagon exists
for), `silent → neutral` (the policy genuinely returned no opinion), `unscorable → info`.
`agreementRate === null` renders `No scorable conflicts yet`; the table never substitutes `0%` for
it, matching the service's own reasoning above. Server 400s from a rejected save render verbatim —
the dialog does not re-implement `resolve-conflict-policy.ts`'s duplicate-rank check client-side,
because a client-side copy of a server rule is a second place for the two to drift.

### CSS: three classes, one widened comment, no seventh stylesheet

`.rank-index`, `.rank-name`, `.rank-actions` in `views.css`, alongside the other page-specific
vocabulary already there (`.dashboard-*`, `.ledger-*`). The rank numeral is rendered rather than
left to the `<ol>` marker because the shared list reset strips markers, and the figure needs
tabular numerals past position 9. `.actionable-row`'s own comment — "links to where you act on it"
— is widened to also cover a row that **is** the thing being acted on, rather than duplicated into
a near-identical `.rank-row`; that duplication is precisely what `.claude/rules/styles.md` exists
to prevent. The hindsight table needed no new CSS at all — it composes entirely from `.panel`,
`.grid`, `.cell-sub`, `.badge`, and `.card-meta`.

## Known bounds

1. **The rules table does not show a metric's resolved (ontology-default) order** when the tenant
   has authored no row for it — only `GET /metric-policies`' authored rows feed the table, and no
   endpoint exposes `METRIC_ONTOLOGY`'s defaults to the SPA. Three metrics
   (`building_area_sf`, `net_operating_income`, `tenant_occupancy_share`) therefore render `No
   order configured` on this page even though a code default governs them today. Hardcoding the
   ontology's defaults client-side was rejected: it would duplicate business data this milestone
   made server-owned and operator-overridable, and would drift the moment the ontology changes.
   This page's scope is what the tenant has authored, not the full resolved picture.
2. **No bulk edit and no add/remove of rankable classes.** The reorder control operates on the
   fixed five-class set every time; broadening or narrowing which classes a metric ranks is not
   built.
3. **`tenant_metrics` has no SPA surface in this milestone.** The API exists
   (`GET`/`PUT`/`DELETE /tenant-metrics`); authoring a label today is a direct API call. Building
   the surface is deferred, not blocked on anything this ADR introduces.

## Consequences

**Good.** An operator can now correct three of eight metrics' authority order without a code
change, and see, in the same page, whether their correction actually agrees with the resolutions a
human has already made — the "propose a winner with reasoning → approve → hindsight check confirms
the rule has been right before" loop this milestone's roadmap names directly. `unscorable` and
`silent` staying distinct means a `0%` or a suspiciously perfect `100%` agreement rate can be
trusted instead of masking conflicts the check could never have judged.

**Costs.** `Button` gained an explicit `ref` prop (`ButtonHTMLAttributes` does not type one) purely
to let `IconButton`'s new `forwardRef` reach the DOM — a two-line, mechanically necessary change
with no behavioural effect on any existing caller. The rules table's known gap above (bound 1)
means an operator auditing this tenant's full survivorship posture still has to cross-reference the
code ontology for metrics nobody has overridden.

## Related

- `docs/adr/0017-survivorship-policy.md` — `resolve-conflict-policy.ts` and `METRIC_ONTOLOGY`, both
  left untouched by this milestone.
- `docs/adr/0021-repository-inventory-beyond-synced-sources.md` — the two-flag admin pattern and
  the `pages/data-room/` split precedent this milestone reuses for `RuleEditorDialog`.
