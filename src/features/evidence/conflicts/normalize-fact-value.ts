import type { FactValue } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { MetricDefinition } from '../facts/metric-ontology';

/**
 * Every `ExtractedFact` persisted by either extractor already carries a unit the ontology
 * recognizes for its metric — both `xlsx-fact-extractor.ts` and `prose-fact-extractor.ts` validate
 * that before persisting, dropping the candidate otherwise. A fact reaching this function with an
 * unknown unit means that upstream guarantee was bypassed (a schema/ontology drift, a document
 * written by a different code path, hand-edited test data) — a real bug, not a normal input, so
 * this fails loud rather than silently skipping the fact from conflict detection.
 */
export class UnknownMetricUnitError extends Error {
  constructor(metricId: string, unit: string) {
    super(`Metric '${metricId}' does not define a conversion for unit '${unit}'`);
  }
}

/** `5.25%`, `0.0525`, and `5.25` (unit `percent`) are the same cap rate expressed three ways;
 * `$12.0M` and `12000000` are the same sale price. This is the one place that reconciles any of
 * them: a metric's `canonicalUnit` is what conflict detection actually compares, and every other
 * unit the ontology lists for that metric converts to it by a pure multiplicative factor. */
export function normalizeFactValue(metric: MetricDefinition, value: FactValue): number {
  const unit = metric.units.find((candidate) => candidate.id === value.unit);
  if (!unit) {
    throw new UnknownMetricUnitError(metric.id, value.unit);
  }
  return value.amount * unit.toCanonicalFactor;
}

/**
 * Whether two already-normalized (canonical-unit) values disagree enough to matter. Failure
 * direction: this is a measurement decision, not a permission gate — an overly sensitive
 * comparison produces a phantom conflict a human reviewer wastes time on, an overly lax one hides
 * a real disagreement, and neither is more "safe" than the other, so there is no fail-open/closed
 * bias here beyond following each metric's own declared `toleranceKind`.
 */
export function isConflictingPair(metric: MetricDefinition, a: number, b: number): boolean {
  const difference = Math.abs(a - b);
  if (metric.toleranceKind === 'absolute') {
    return difference > metric.tolerance;
  }
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? difference > 0 : difference / base > metric.tolerance;
}
