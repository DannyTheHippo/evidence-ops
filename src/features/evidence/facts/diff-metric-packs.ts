import type {
  MetricDefinition,
  MetricPackData,
} from '../../../database/schemas/evidence/metric-pack/metric-pack.schema';

/** A metric's detection-relevant configuration, collapsed to one comparable string: `canonicalUnit`,
 *  `toleranceKind`, `tolerance`, and every unit id's `toCanonicalFactor` — exactly the fields
 *  `detectConflicts` (`../conflicts/detect-conflicts.ts`, via `normalizeFactValue`) reads to decide
 *  whether two facts disagree. `units` is sorted by id first so a reordered-but-unchanged unit list
 *  still compares equal. `label`/`aliases`/`valueType`/`authorityOrder`/`stalenessWindowMs` are
 *  deliberately excluded — none of them changes what `detectConflicts` computes. */
function detectionSignature(metric: MetricDefinition): string {
  const units = [...metric.units]
    .map((unit) => `${unit.id}:${unit.toCanonicalFactor}`)
    .sort()
    .join(',');
  return `${metric.canonicalUnit}|${metric.toleranceKind}|${metric.tolerance}|${units}`;
}

/**
 * Metric ids whose detection-relevant configuration changed between `previous` and `next` — added,
 * removed, or present in both with a different `detectionSignature`. This is the seam
 * `MetricPacksService.activate` names to `rescanConflicts` (`src/workflows/rescan-conflicts.workflow.ts`)
 * so an activation rescans only what its own pack version actually changed detection-wise, and
 * `ConflictsService.previewPackActivation` uses the identical function to preview the same set
 * before a version is ever activated.
 *
 * A metric present in both packs with an identical signature — a relabel, a new alias, a reordered
 * `units` array with the same factors — is never included: those edits change nothing
 * `detectConflicts` reads, so rescanning for them would retract and recreate conflicts that never
 * actually changed.
 */
export function diffDetectionRelevantMetrics(
  previous: MetricPackData,
  next: MetricPackData,
): string[] {
  const previousById = new Map(previous.metrics.map((metric) => [metric.id, metric]));
  const nextById = new Map(next.metrics.map((metric) => [metric.id, metric]));

  const changed = new Set<string>();

  for (const [id, metric] of nextById) {
    const previousMetric = previousById.get(id);
    if (!previousMetric || detectionSignature(previousMetric) !== detectionSignature(metric)) {
      changed.add(id);
    }
  }
  for (const id of previousById.keys()) {
    if (!nextById.has(id)) {
      changed.add(id);
    }
  }

  return [...changed];
}
