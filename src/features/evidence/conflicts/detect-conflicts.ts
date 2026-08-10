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
 * than the metric's tolerance. A group of size one trivially cannot disagree with itself and is
 * skipped without normalizing it — normalization can throw (`UnknownMetricUnitError`), and a
 * singleton group has no comparison to make that throwing would protect.
 *
 * `magnitude` is the canonical-unit spread across the *whole* group (max − min), not just the
 * pair that exceeded tolerance — with three or more facts sharing a key, the conflict is a
 * property of the group's disagreement as a whole, not of any two facts picked out of it.
 */
export function detectConflicts(
  facts: readonly FactForConflictScan[],
  ontology: readonly MetricDefinition[],
): ConflictCandidate[] {
  const groups = new Map<string, FactForConflictScan[]>();
  for (const fact of facts) {
    const key = groupKey(fact.factKey);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const conflicts: ConflictCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const metric = findMetricById(ontology, group[0].factKey.metric);
    if (!metric) {
      // Fails open: every fact in the group was validated against the ontology before it was
      // persisted (see normalize-fact-value.ts's own comment), so this should not happen. If the
      // ontology and stored data ever drift, skipping this one group is safer than aborting the
      // whole scan and hiding every other conflict behind it.
      continue;
    }

    const normalized = group.map((fact) => ({
      fact,
      canonical: normalizeFactValue(metric, fact.value),
    }));
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

  return conflicts;
}
