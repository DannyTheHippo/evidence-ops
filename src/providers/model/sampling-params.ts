import type { TaskClass } from './model-provider.interface';

/**
 * Per-`taskClass` sampling temperature. A constant table, not an env var — this is a product/
 * determinism decision that must not vary by deployment, so it does not earn the six-place
 * environment-variable checklist (`contexts/configuration.md`) for a value nothing should ever
 * override at runtime.
 *
 * `fact_extraction` backs the deterministic conflict detector (`ConflictsService`): the same
 * document extracted twice must yield the same *set* of facts, or a seeded conflict silently
 * stops being found. Measured on a live eval run: 8 facts from `valuation-memo.pdf` on one call,
 * 2 on the next, from byte-identical input, entirely from unpinned sampling.
 *
 * `qa_answer` gets the same `0` rather than a nonzero value some variety-in-phrasing case could
 * argue for: a little prose variation between identical questions is harmless, but the grounding
 * gate verifies a specific *set* of claims and citations, and that set — not just its wording —
 * is exactly what `temperature` is free to vary at nonzero values. There is no product value in
 * that variance and a real cost (a citation set that isn't reproducible for the same question).
 *
 * `temperature: 0` sharply narrows run-to-run variance; it is not a determinism guarantee at the
 * API level — Anthropic documents no such guarantee — so this reduces the failure rate, it does
 * not eliminate it.
 */
const SAMPLING_TEMPERATURE_BY_TASK_CLASS: Record<TaskClass, number> = {
  fact_extraction: 0,
  qa_answer: 0,
};

export function resolveSamplingTemperature(taskClass: TaskClass): number {
  return SAMPLING_TEMPERATURE_BY_TASK_CLASS[taskClass];
}
