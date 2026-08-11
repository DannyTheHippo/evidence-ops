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
}

/** A fact `normalizeFactValue` could not convert to its metric's canonical unit, dropped from
 * conflict detection rather than aborting the scan — see `normalize-fact-value.ts`'s own
 * failure-direction comment. Carries the whole fact (mirrors `RejectedFactCandidate` in
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

/** `entity` is free text an extractor read off a document, so it is compared trimmed and
 * lowercased ("Northgate Business Park" vs "northgate business park") — `metric` and `period` are
 * both already canonical (a metric id from the ontology, a period from `derivePeriodFromDateText`)
 * and compared exactly. Exported so `ConflictsService` can key its idempotency check
 * (already-open conflicts) the same way this function keys its grouping. */
export function groupKey(factKey: FactKey): string {
  return `${factKey.entity.trim().toLowerCase()}::${factKey.metric}::${factKey.period}`;
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
 * A fact whose unit `normalizeFactValue` cannot convert is dropped from its group (recorded in
 * `skipped`) rather than aborting the whole scan. If dropping it leaves the group with fewer than
 * two normalizable facts, the remaining fact(s) have nothing left to disagree with and the group
 * is skipped without emitting a `ConflictCandidate`.
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
      // Fails open: every fact in the group was validated against the ontology before it was
      // persisted (see normalize-fact-value.ts's own comment), so this should not happen. If the
      // ontology and stored data ever drift, skipping this one group is safer than aborting the
      // whole scan and hiding every other conflict behind it.
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
      });
    }
  }

  return { conflicts, skipped };
}
