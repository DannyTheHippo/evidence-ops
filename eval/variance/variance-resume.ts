import type { VarianceCaseRun } from './variance-report';

/**
 * The shape written to disk after every observed case, and the shape `--resume` reads back. Wider
 * than one pass: `passLabels` carries the git sha the process was running under when each pass
 * started, so a tree that went from clean to dirty mid-run (or back) is visible per pass rather than
 * only in the file's own name.
 */
export interface VarianceProgress {
  readonly baseGitSha: string;
  readonly datasetFingerprint: string;
  readonly corpusFingerprint: string;
  readonly requestedRunCount: number;
  readonly passLabels: readonly {
    readonly runIndex: number;
    readonly gitSha: string;
    readonly startedAt: string;
  }[];
  readonly observations: readonly VarianceCaseRun[];
}

const DIRTY_SUFFIX = '-dirty';

/**
 * Strips one trailing `-dirty` suffix (added by `gitSha()` when the working tree is not clean) so a
 * resumed run is located by the sha alone regardless of whether the tree was clean when the label
 * that named the file was written. Only a trailing occurrence is stripped — a sha that happens to
 * contain `-dirty` elsewhere is left untouched.
 */
export function baseSha(label: string): string {
  return label.endsWith(DIRTY_SUFFIX) ? label.slice(0, -DIRTY_SUFFIX.length) : label;
}

/**
 * Observations belonging to a pass (`runIndex`) that has every case in `caseIds` recorded. A pass
 * still in progress when the process stopped has some but not all of its cases observed; excluding
 * it here is what keeps `aggregateVariance` (which throws on a case missing a pass, see
 * `aggregate-variance.ts:157-169`) fed only complete passes.
 */
export function completeObservations(
  observations: readonly VarianceCaseRun[],
  caseIds: readonly string[],
): readonly VarianceCaseRun[] {
  const completeRunIndexes = new Set(
    [...new Set(observations.map((observation) => observation.runIndex))].filter((runIndex) => {
      const observedIds = new Set(
        observations
          .filter((observation) => observation.runIndex === runIndex)
          .map((observation) => observation.caseId),
      );
      return caseIds.every((caseId) => observedIds.has(caseId));
    }),
  );
  return observations.filter((observation) => completeRunIndexes.has(observation.runIndex));
}

/** Count of passes with every case in `caseIds` observed — the `runCount` a resumed report reports. */
export function completedPassCount(
  observations: readonly VarianceCaseRun[],
  caseIds: readonly string[],
): number {
  return new Set(
    completeObservations(observations, caseIds).map((observation) => observation.runIndex),
  ).size;
}

/**
 * Every (runIndex, caseId) slot not yet observed, across `requestedRunCount` passes over `caseIds`,
 * in pass-then-case order. The first entry is always the earliest missing slot, which is where a
 * resumed run picks back up; a live pass that stopped mid-way never re-serves an already-observed
 * case as though it were unrun.
 */
export function nextObservationSlots(
  observations: readonly VarianceCaseRun[],
  caseIds: readonly string[],
  requestedRunCount: number,
): readonly { readonly runIndex: number; readonly caseId: string }[] {
  const observedKeys = new Set(
    observations.map((observation) => `${observation.runIndex}:${observation.caseId}`),
  );
  const slots: { runIndex: number; caseId: string }[] = [];
  for (let runIndex = 1; runIndex <= requestedRunCount; runIndex += 1) {
    for (const caseId of caseIds) {
      if (!observedKeys.has(`${runIndex}:${caseId}`)) {
        slots.push({ runIndex, caseId });
      }
    }
  }
  return slots;
}

/**
 * Refuses a resume whose dataset, corpus or requested run count differ from the progress file on
 * disk — continuing would silently splice passes measured against one dataset or corpus onto passes
 * measured against another, reporting a spread that was never actually observed under one fixed
 * setup. Fails CLOSED: this guards the measurement's validity, not availability.
 */
export function assertResumable(
  existing: VarianceProgress,
  current: Pick<VarianceProgress, 'datasetFingerprint' | 'corpusFingerprint' | 'requestedRunCount'>,
): void {
  if (existing.datasetFingerprint !== current.datasetFingerprint) {
    throw new Error(
      `eval: --resume refused — datasetFingerprint changed (recorded ` +
        `${existing.datasetFingerprint}, current ${current.datasetFingerprint})`,
    );
  }
  if (existing.corpusFingerprint !== current.corpusFingerprint) {
    throw new Error(
      `eval: --resume refused — corpusFingerprint changed (recorded ` +
        `${existing.corpusFingerprint}, current ${current.corpusFingerprint})`,
    );
  }
  if (existing.requestedRunCount !== current.requestedRunCount) {
    throw new Error(
      `eval: --resume refused — requestedRunCount changed (recorded ` +
        `${existing.requestedRunCount}, current ${current.requestedRunCount})`,
    );
  }
}
