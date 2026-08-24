# ADR-0025 — Versioned metric packs: tolerance is editable, unit arithmetic is not

- **Status:** Accepted — `MetricPack` implemented (`metric-pack.schema.ts`), authoring lifecycle
  (`MetricPacksService.createDraft`/`publish`/`activate`, `metric-packs.controller.ts`),
  activation-scoped rescan (`rescanConflicts` workflow, `diffDetectionRelevantMetrics`),
  pre-activation preview (`ConflictsService.previewPackActivation`,
  `metric-pack-preview.controller.ts`), and the CRE-v1 backfill (`migrations/0030-metric-packs.ts`)
  are all shipped
- **Date:** 2026-08-24
- **Supersedes:** —
- **Amends:** `docs/adr/0022-operator-authored-resolution-rules-and-tenant-measures.md` (see
  § What this supersedes)

## Context

`METRIC_ONTOLOGY` (`metric-ontology.ts`) has been the sole source of detection behaviour since the
first commit: eight commercial-real-estate metrics, their canonical units, their tolerances, hardcoded
in a TypeScript constant every extractor and `detectConflicts` imported directly. Conflict detection
and survivorship — the differentiated half of this product, the reason a client would pay for this
over a plain document store — ran entirely on that one file. "Generic and reusable" was a claim
the code did not support: a second engagement in a domain other than CRE (a lending book, a fund
administration mandate, anything whose metrics are not sale prices and cap rates) could not be
served without shipping new code and redeploying. ADR-0022 gave a tenant editable `authorityOrder`
and `stalenessWindowMs` per metric, and editable labels — but deliberately kept `tolerance` and
`canonicalUnit`/`units` fixed, because at the time there was no versioning story that could make an
edit to either honest (see that ADR's own § `tenant_metrics`: labels are tenant-owned, detection is
not). This ADR is that versioning story, and the reason it took a whole design rather than just
adding two more editable fields to `metric_policies`.

## Decision

### Tolerance reads forward; a conversion factor reads backward — and that asymmetry is the whole reason versioning is honest here

A metric's `tolerance` governs one thing: whether the *next* scan treats two normalized values as
disagreeing. `ConflictsService.scanForConflicts`/`scanForConflictsByMetrics` resolve the tenant's
active pack once per call and stamp the resulting `packId`/`packVersion` onto every `Conflict` they
write (`detectAndPersist`). A conflict detected under tolerance v1 stays a v1 conflict forever —
its own row already says which tolerance ran, so a later tolerance edit changes nothing about what
that row means. Editing a tolerance is safe to version: the stamp on the fact or conflict it
produced is already a complete, honest record of the rule that was in force.

A `canonicalUnit` and its `units[].toCanonicalFactor` do not work this way. `normalizeFactValue`
re-multiplies every stored fact's raw `{amount, unit}` against the **active** pack's factors on
**every** scan — not the pack active when the fact was extracted. A `Conflict.magnitude` recomputed
today from `cap_rate`'s current factor (`percent → 0.0025 per point`, say) reinterprets a fact
extracted three tenants and two years ago identically to one extracted this morning. No version
stamp on the fact can fix this, because the stamp says which pack *produced* the fact, not which
pack's arithmetic is currently being applied to it — and the arithmetic that matters for today's
scan is whatever the *active* pack says, regardless of what any historical fact is stamped with.

State the concrete failure this prevents. Suppose an operator notices `base_rent_psf`'s
`usd_per_sf_per_year` factor was mistyped — off by a factor of twelve, months instead of years — and
"fixes" it in a new pack version. Every fact extracted under the old factor is now silently
reinterpreted the moment that version activates: some genuine disagreements stop clearing tolerance
and vanish (`retractConflicts` closes them with outcome `'retracted'`), others that used to agree
now diverge and a new conflict opens against facts nobody re-extracted. Nothing about this looks
like data corruption from the audit log's point of view — it looks like a normal, versioned,
fully-attributed pack activation: a draft was created, reviewed, published, activated, and every
retraction and creation it triggered carries a `packId`/`packVersion` stamp explaining exactly why.
That paper trail is *more* trustworthy-looking than if nobody had built any of this at all, and it
would be lying about what actually happened — an operator reading it would conclude "the system
caught a stale disagreement," not "a factor typo just silently rewrote history." `assertFrozenArithmetic`
(`MetricPacksService.publish`) exists to make that shape of edit structurally impossible to publish,
not merely discouraged: a draft that changes a surviving metric's `canonicalUnit`, or drops or
changes any unit id's `toCanonicalFactor` the parent defined, is refused with
`MetricPackFrozenArithmeticException` before it ever leaves `draft` status. Adding a brand-new unit
id is always allowed — that only widens what a future fact's unit field can say, it never
reinterprets a past one.

The escape hatch for a genuinely wrong factor is not an edit: it is a new pack **lineage** (a fresh
`packId`, not a new version of the existing one) plus re-extraction of whatever facts need the
corrected arithmetic. A new lineage's facts stamp a `packId` that never shared arithmetic with the
old one, so there is nothing for a version stamp to retroactively reinterpret.

### What the rows record, and why each field is required rather than left absent

`ExtractedFact.packId`/`packVersion` (stamped by `FactsService.extractFacts`, from the same
`resolveActive` call that resolved the ontology extraction validated the fact's metric against) and
`Conflict.packId`/`packVersion` (stamped by `ConflictsService.detectAndPersist`) are both required
fields, not optional ones. `Conflict.magnitudeUnit` is required too — the metric's `canonicalUnit`
in force when `detectConflicts` computed that row's `max - min` spread, because a stored `0.0085` is
85 basis points only when the canonical unit is a ratio and would be 0.85 percent under a different
canonical unit; nothing else on the row says which. Once a pack can edit a metric's canonical unit
across lineages, the same stored number would silently mean two different things across rows with
no way to tell them apart.

The precedent is `EvidenceLocator.extractorVersion` (ADR-0008): "a citation that cannot state which
extractor produced its coordinates is not verifiable — it will resolve to *something*, quietly, and
that something may be the wrong span." The same reasoning applies one level up the stack here — a
fact or conflict that cannot state which pack's ontology and tolerance produced it resolves against
whatever pack happens to be active when someone reads it, quietly, and that pack may not be the one
that actually judged it. `ConflictResponseDto.stale`/`staleReason` (`ConflictsService.toConflictDto`)
makes the mismatch visible rather than silent: a conflict whose stamped `(packId, packVersion)`
no longer matches the tenant's currently active pack is flagged, independent of whether its evidence
is otherwise intact.

### The CRE-v1 backfill is truthful, not fabricated — and that is a deliberate departure from the repo's usual posture

`migrations/0030-metric-packs.ts` stamps every pre-existing `extracted_facts`/`conflicts` row with
`packId: 'cre'`, `packVersion: 1`. This codebase's usual instinct, stated across several other ADRs
and schema comments, is that an unknown historical value should be left absent rather than guessed —
a fabricated default is worse than a visible gap. This backfill is the deliberate exception, and the
reason it is safe is narrow and specific: `CRE_PACK_V1` (`packs/cre.pack.ts`) is not a guess at what
the historical ontology might have been, it is `METRIC_ONTOLOGY` itself, re-exported byte-identical
under the pack shape (`CRE_PACK_V1.metrics === METRIC_ONTOLOGY`, no retuned copy). Every row this
backfill touches was, provably, detected or extracted against exactly that ontology, because no
other ontology has ever existed in this codebase until this change shipped. The claim `packId: 'cre'
v1` is verifiable against the code as of the day the migration runs, not asserted on faith the way an
ordinary "assume the default" backfill would be — which is exactly why it is justified here and
would not be justified for a field with genuine historical ambiguity behind it.

### Activation diffs, so a labels-only version rescans nothing

`MetricPacksService.activate` never re-scans a tenant's whole fact corpus. It computes
`diffDetectionRelevantMetrics(previousPack, activatedPack)` (`diff-metric-packs.ts`) — a per-metric
signature over exactly the fields `detectConflicts` reads (`canonicalUnit`, `toleranceKind`,
`tolerance`, every unit id's `toCanonicalFactor`, sorted so a reordered-but-unchanged unit list still
compares equal) — and starts the `rescanConflicts` workflow scoped to only the metric ids whose
signature actually changed. `label`, `aliases`, `authorityOrder`, and `stalenessWindowMs` are
deliberately excluded from the signature: none of them changes what `detectConflicts` computes, so a
version that only relabels a metric or adds a search alias diffs to an empty set and starts no
workflow at all. `ConflictsService.previewPackActivation` calls the identical diff function before a
version is ever activated, so an operator sees the same "nothing would change" answer a real
activation would produce, for the same reason.

`rescanConflicts` (`src/workflows/rescan-conflicts.workflow.ts`) runs two activities in sequence —
`scanForConflictsByMetrics` then `retractConflicts`, both scoped to `input.metricIds` — over
disjoint conflict groups (the first only ever creates a conflict where none exists; the second only
ever closes an already-open one), so the ordering has no correctness effect. `retractConflicts`
writes `status: 'dismissed'` with `resolution.outcome: 'retracted'`, **never** `'resolved'` —
`ConflictResolutionOutcome`'s own doc comment states why: `MeasuresService.getForTenant`'s
`conflictsResolved` counts `status: 'resolved'` only, and a machine retraction landing in that count
would inflate the one number the pilot's ROI story rests on. A reviewer's "we resolved forty
conflicts this month" needs to mean forty human decisions, not thirty-eight human decisions and two
tolerance-edit side effects that happened to close on their own.

Both ends of the retraction/approval race are closed, and either end alone is insufficient given
that a conflict stays `open` for its entire (up to 24-hour) approval wait:

- `retractConflicts`' own candidate selection (`ConflictsService.findRetractableConflicts`) excludes
  any conflict carrying a pending resolution `Approval`. Without this, a rescan racing a human's
  in-flight decision could close a conflict a reviewer is actively about to approve, discarding their
  decision before it lands.
- `recordResolution` refuses, on every outcome branch, a conflict already `dismissed` with
  `resolution.outcome === 'retracted'`. Without this, a `resolveConflict` execution that started
  *before* a retraction landed but wakes *after* it — `loadConflictForResolution` only checked
  `status === 'open'` up to 24 hours earlier, and `resolveConflict` never re-checks before waking —
  would silently overwrite the retraction's provenance with a late human decision, even though
  `status` itself never moves back off `'dismissed'`.

Neither guard alone is sufficient: the first stops a rescan from clobbering an approval already in
flight when the rescan runs; the second stops a stale approval from clobbering a retraction that
landed while the approval was in flight. A day-long approval wait makes both orderings reachable in
practice, not merely theoretical.

### A metric dropped from the active pack scores `unscorable`, not `silent`

`ResolutionBacktestService.scoreConflict` gates on `policies.has(conflict.factKey.metric)` — a
metric the tenant's currently resolved active pack no longer defines — **before** ever calling
`resolveConflictPolicy`, returning `verdict: 'unscorable'` rather than letting the policy call run
and return `ruleFired: 'none'`. This preserves the distinction ADR-0022 established between the two
verdicts: `silent` means "your rule has no opinion here, consider authoring one" — there is a metric,
there is a policy row (or an ontology default) to consult, and it simply declined to propose a
winner. `unscorable` means "we cannot tell you anything about this one." A dropped metric has no
rule to author in the first place — there is nothing left to configure a policy *for* — so scoring it
`silent` would suggest an actionable gap that does not exist, and would silently pollute the
`agreementRate` denominator's sibling counts with a state the backtest was never designed to
represent. The same three-gates-before-any-policy-call shape `ResolutionBacktestService` already
used for a starved candidate set and a winner-less outcome (ADR-0022) is what this metric-removal
gate extends, not a new mechanism.

### What this supersedes

ADR-0022's § `tenant_metrics`: labels are tenant-owned, detection is not asserted flatly: "Fact
extraction and conflict detection both read `METRIC_ONTOLOGY` directly and never this collection, so
changing either would silently redefine, after the fact, which of a tenant's already-detected
conflicts should have existed at all." That statement is now **reversed** for a pack-authored
metric: `detectConflicts` and the extractors read a tenant's *resolved metric pack*
(`MetricPacksService.resolveActive`), not `METRIC_ONTOLOGY` directly, and a pack-authored metric
carries its own `tolerance`, `canonicalUnit`, and `units` — a tenant *can* now define detection for a
metric of its own, provided it goes through the versioned authoring lifecycle this ADR describes
(draft → publish, gated by `assertFrozenArithmetic` and `assertNoUnacknowledgedRemovals` → activate,
gated by the scoped rescan above) rather than a direct field edit. ADR-0022 is amended in place — the
same register ADR-0016 was amended by ADR-0023 — to point here rather than restate the reversed
claim.

**`tenant_metrics` has NOT been migrated into packs, and the collection has not been dropped.**
`TenantMetricsService`, `tenant-metric.schema.ts`, and `TenantMetricsController` are all still
present and wired into `FactsModule` exactly as ADR-0022 shipped them — a tenant can still rename a
code-ontology metric's display label or add a label-only catalog entry through that surface, and
`isCustomMetricId` still reads `METRIC_IDS` to decide whether a row is a rename or an addition.
Nothing in this change reads `tenant_metrics` for detection, and nothing in this change moves a
`tenant_metrics` row into `metric_packs`. That overlap — a tenant can now *also* author a whole
metric's detection through a pack, while the older label-only surface keeps working unchanged and
un-migrated — is deliberate follow-up work, not an oversight this ADR is hiding. An ADR claiming a
migration that has not happened would be worse than one that names the gap plainly, which is what
this section does.

## Known bounds

1. **`previewPackActivation` is a projection, not a transaction.** It computes would-create and
   would-retract counts by re-running `detectConflicts`/`findRetractableConflicts` against the
   tenant's current facts, without writing a `Conflict` row for either half. The corpus can change
   between a preview call and the operator actually clicking activate — a fact ingested, a conflict
   resolved, another pack activated by a concurrent admin session — and a real activation's rescan can
   therefore produce different counts than the preview promised. This is the same class of bound
   `ConflictsService`'s own docs already accept for `findRetractableConflicts`'s pending-approval
   check (a preview that promised a retraction a real activation would refuse would be dishonest about
   what commit does) — the preview is honest about what it can and cannot guarantee, not a strong
   consistency claim.
2. **The eval tenant is pinned to CRE v1.** `eval/run.ts`'s `EVAL_TENANT_ID = 'eval'` never authors or
   activates a `MetricPack` row, so `MetricPacksService.resolveActive('eval')` always falls back to
   the code default `CRE_PACK_V1` — the identical fallback every tenant with no authored pack gets.
   A pack edit anywhere else in the system cannot silently invalidate the eval replay corpus or its
   cached results, because the eval tenant's detection config is structurally incapable of changing
   short of a code change to `METRIC_ONTOLOGY` itself. This is a property of the fallback design, not
   a special case coded for eval.
3. **`tenant_metrics` and `metric_packs` are two label/detection surfaces with no reconciliation
   between them.** See § What this supersedes above — a tenant can rename a metric via
   `tenant_metrics` and separately author a whole competing detection definition for the same metric
   id via `metric_packs`, and nothing today checks the two agree or warns when they diverge.
4. **Publish-time checks (`assertFrozenArithmetic`, `assertNoUnacknowledgedRemovals`) run once, at
   publish, against the draft's own stamped parent** (`MetricPack.parentPackId`/`parentVersion`, fixed
   at draft-creation time). They do not re-run at activation time against whatever pack happens to be
   active then, which can differ from the stamped parent if another version activated in between draft
   creation and this draft's own publish. `MetricPacksService.activate`'s rescan is computed against
   whatever *is* active at activation time regardless, so the rescan itself stays correct — but an
   operator publishing a long-lived draft against a now-superseded parent gets no fresh frozen-arithmetic
   check against the pack that will actually be superseded when they activate.

## Consequences

**Good.** Conflict detection and survivorship are no longer a single hardcoded CRE ontology — a
tenant can author, preview, and activate a whole metric's detection configuration, scoped to exactly
the metrics that changed rather than a blanket re-scan, with a paper trail that says which pack
version judged which fact and which conflict. The frozen-arithmetic rule turns "an operator can
silently rewrite history by fixing a typo" from a live risk into a structurally refused publish.

**Costs.** Authoring a pack-defined metric is a longer lifecycle (draft → publish → activate, three
admin-gated steps) than editing `tenant_metrics` or `metric_policies` ever were — deliberately, since
the thing being protected is arithmetic that reinterprets history if it moves. `MetricPack`'s schema
carries more required fields (`packId`, `version`, `status`, `parentPackId`/`parentVersion`) than
either of ADR-0022's simpler collections. A correction to a genuinely wrong factor needs a whole new
pack lineage and re-extraction, not a one-line fix — the accepted cost of making the honest path the
only path.

**Deferred, deliberately.** Migrating `tenant_metrics` rows into `metric_packs`, and reconciling the
two label/detection surfaces so they cannot silently diverge on the same metric id, is real follow-up
work this ADR does not do (Known bounds 3, § What this supersedes). Re-running the publish-time
frozen-arithmetic check against the activation-time active pack rather than only the draft's stamped
parent (Known bounds 4) is a narrower gap in the same direction.

## Related

- `docs/adr/0008-locator-provenance-and-extractor-versioning.md` — the `extractorVersion`
  precedent this ADR's `packId`/`packVersion` stamping follows: a coordinate (or, here, a fact or
  conflict) that cannot say which extractor (or pack) produced it resolves to something, quietly.
- `docs/adr/0017-survivorship-policy.md` — `resolve-conflict-policy.ts`, unmodified by this change;
  a pack-authored metric's `authorityOrder`/`stalenessWindowMs` still resolve through
  `MetricPoliciesService.resolveForTenant`, folded over whichever pack `resolveActive` returns.
- `docs/adr/0022-operator-authored-resolution-rules-and-tenant-measures.md` — amended by this ADR:
  its `tenant_metrics` section's "detection is not tenant-owned" claim is reversed for a
  pack-authored metric; its `unscorable`/`silent` split is extended, not replaced, by this ADR's
  metric-removal gate.
- `docs/adr/0024-evidence-lifecycle-and-withdrawal.md` — the most recent versioning/attribution
  precedent in this codebase (`DocumentVersion.withdrawnAt`), and the freshest ADR this document's
  format follows.
- `docs/global/architecture.md` — the workflow list (`rescanConflicts`, the fifth workflow type) and
  route inventory (`MetricPacksController`, `MetricPackPreviewController`) this ADR's implementation
  is reflected in.
