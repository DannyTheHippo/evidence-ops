import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type {
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { findMetricById, type MetricDefinition } from '../facts/metric-ontology';
import { isConflictingPair, normalizeFactValue } from './normalize-fact-value';

export interface FactForConflictScan {
  readonly id: string;
  readonly factKey: FactKey;
  readonly value: FactValue;
}

export interface ConflictCandidate {
  readonly factKey: FactKey;
  readonly factIds: string[];
  readonly magnitude: number;
  /** The metric's `canonicalUnit` `magnitude` is expressed in — see `Conflict.magnitudeUnit`'s own
   * doc comment for why this travels with the candidate instead of being re-derived later. */
  readonly magnitudeUnit: string;
}

/** A fact conflict detection cannot measure: `normalizeFactValue` has no conversion for its unit,
 * or its canonical value is not a finite number. Dropped from the scan rather than aborting it —
 * see `normalize-fact-value.ts`'s own failure-direction comment, and `detectConflicts`'s own
 * comment on why a non-finite value must not be compared. Carries the whole fact (mirrors
 * `RejectedFactCandidate` in
 * `prose-fact-extractor.ts`) so a caller can log or report the metric, unit, and fact id without
 * this module re-deriving them from a separate reason string. */
export interface SkippedFact {
  readonly fact: FactForConflictScan;
  readonly reason: string;
}

export interface DetectConflictsResult {
  readonly conflicts: ConflictCandidate[];
  readonly skipped: SkippedFact[];
}

/** `entity` is free text an extractor read off a document, so it is compared through
 * `normalizeEntityName` — the same function the `CanonicalEntity` registry normalises with, so a
 * name that resolves to a registry entry and a name that is keyed here fold identically, and a PDF
 * text layer's fullwidth or double-spaced rendering of "Acme Tower" stops being its own group.
 * `metric` and `period` are both already canonical (a metric id from the ontology, a period key
 * from `parsePeriod`) and compared exactly. Exported so `ConflictsService` can key its idempotency
 * check (already-open conflicts) the same way this function keys its grouping. */
export function groupKey(factKey: FactKey): string {
  return `${normalizeEntityName(factKey.entity)}::${factKey.metric}::${factKey.period}`;
}

/**
 * Groups facts by `(entity, metric, period)`, normalizes each group's values to its metric's
 * canonical unit, and emits a `ConflictCandidate` for any group whose normalized values span more
 * than the metric's tolerance.
 *
 * Every fact is normalized, even in a group of size one that trivially cannot disagree with
 * itself — normalizing costs nothing now that `normalizeFactValue` cannot throw, and skipping a
 * singleton's normalization would silently hide an unrecognized unit that happened to be the only
 * fact for its `(entity, metric, period)`, which is exactly the invisible-drop this function
 * exists to avoid (see `normalize-fact-value.ts`'s failure-direction comment for why it returns
 * `undefined` rather than throwing).
 *
 * A fact whose unit `normalizeFactValue` cannot convert, and a fact whose canonical value is not a
 * finite number, are both dropped from their group (recorded in `skipped`) rather than aborting the
 * whole scan. If dropping one leaves the group with fewer than two normalizable facts, the
 * remaining fact(s) have nothing left to disagree with and the group is skipped without emitting a
 * `ConflictCandidate`.
 *
 * `magnitude` is the canonical-unit spread across the *whole* (normalizable) group (max − min),
 * not just the pair that exceeded tolerance — with three or more facts sharing a key, the conflict
 * is a property of the group's disagreement as a whole, not of any two facts picked out of it.
 */
export function detectConflicts(
  facts: readonly FactForConflictScan[],
  ontology: readonly MetricDefinition[],
): DetectConflictsResult {
  const groups = new Map<string, FactForConflictScan[]>();
  for (const fact of facts) {
    const key = groupKey(fact.factKey);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const conflicts: ConflictCandidate[] = [];
  const skipped: SkippedFact[] = [];
  for (const group of groups.values()) {
    const metric = findMetricById(ontology, group[0].factKey.metric);
    if (!metric) {
      // Fails open: `ontology` is the tenant's *currently* confirmed measures, and a fact's slug
      // can outlive the measure it was extracted under (a since-rejected header proposal, a
      // measure a rescan hasn't reached yet) — a group whose slug names no confirmed measure is
      // skipped rather than aborting the whole scan and hiding every other conflict behind it.
      continue;
    }

    const normalized: { fact: FactForConflictScan; canonical: number }[] = [];
    for (const fact of group) {
      const canonical = normalizeFactValue(metric, fact.value);
      if (canonical === undefined) {
        skipped.push({
          fact,
          reason: `Metric '${metric.id}' does not define a conversion for unit '${fact.value.unit}'`,
        });
        continue;
      }
      // Fails toward skipped, never toward agreement. Every tolerance comparison in
      // `isConflictingPair` is a `>`, and `>` against a `NaN` — which `Infinity - Infinity` and
      // `difference / base` with a non-finite base both produce — is `false`, so one non-finite
      // value in a group reads as "these figures agree" and closes a real disagreement invisibly.
      // For an absolute-tolerance metric the mirror failure applies: a conflict with an infinite
      // magnitude, which BSON stores as a double and `JSON.stringify` serializes as `null`.
      // Dropping the fact instead leaves the group measured only by the facts that can be
      // measured, and `ConflictsService.findRetractableConflicts` excludes a skipped group from
      // retraction, so an already-open conflict cannot be closed by one unmeasurable fact either.
      if (!Number.isFinite(canonical)) {
        skipped.push({
          fact,
          reason: `Fact value '${fact.value.amount} ${fact.value.unit}' does not convert to a finite ${metric.canonicalUnit} value for metric '${metric.id}'`,
        });
        continue;
      }
      normalized.push({ fact, canonical });
    }
    if (normalized.length < 2) {
      // Fewer than two normalizable values means nothing left to compare — whether the group
      // started as a singleton or was whittled down to one (or zero) by dropping unit(s) above.
      continue;
    }

    const canonicalValues = normalized.map((entry) => entry.canonical);
    const min = Math.min(...canonicalValues);
    const max = Math.max(...canonicalValues);

    if (isConflictingPair(metric, min, max)) {
      conflicts.push({
        factKey: group[0].factKey,
        factIds: normalized.map((entry) => entry.fact.id),
        magnitude: max - min,
        magnitudeUnit: metric.canonicalUnit,
      });
    }
  }

  return { conflicts, skipped };
}
