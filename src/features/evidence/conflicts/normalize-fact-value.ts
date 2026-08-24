import type { FactValue } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
// The pack schema's `MetricDefinition` (`id: string`) rather than `metric-ontology.ts`'s own
// (`id: MetricId`) — neither function here reads `.id`, and the wider type lets a caller working
// from a resolved `MetricPackData` pass its metrics straight through without narrowing.
import type { MetricDefinition } from '../../../database/schemas/evidence/metric-pack/metric-pack.schema';

/** `5.25%`, `0.0525`, and `5.25` (unit `percent`) are the same cap rate expressed three ways;
 * `$12.0M` and `12000000` are the same sale price. This is the one place that reconciles any of
 * them: a metric's `canonicalUnit` is what conflict detection actually compares, and every other
 * unit the ontology lists for that metric converts to it by a pure multiplicative factor.
 *
 * Returns `undefined`, mirroring `parseDisplayValue`'s sibling parsers in `xlsx-fact-extractor.ts`,
 * rather than throwing. Both extractors validate unit-per-metric before persisting (`extractXlsxFacts`
 * and `extractProseFacts` each reject a candidate whose unit isn't declared for its metric), so an
 * unrecognized unit reaching this function should not happen for a fact either extractor produced
 * today — but this function has no way to know an `ExtractedFact`'s unit came from a validated path,
 * and a future extractor or a stored document predating a validation fix is exactly the case this
 * guards against. Conflict detection is a measurement, not a permission gate, so it must fail open:
 * the caller drops the one fact it cannot normalize and keeps comparing the rest, rather than a bad
 * unit aborting the whole scan. */
export function normalizeFactValue(metric: MetricDefinition, value: FactValue): number | undefined {
  const unit = metric.units.find((candidate) => candidate.id === value.unit);
  return unit ? value.amount * unit.toCanonicalFactor : undefined;
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
