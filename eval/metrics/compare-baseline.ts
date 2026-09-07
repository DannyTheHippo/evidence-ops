import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { EvalMetrics } from './compute-metrics';

/**
 * The gated subset of `EvalMetrics`, each carrying its own regression direction rather than a
 * global "smaller is worse" rule. `retrieval.recallAt5`/`recallAt10`/`mrr` and every accuracy/
 * precision/coverage rate regress when they drop (`higher`); the two canary leak rates regress
 * when they rise (`lower`), because they measure how often a prompt-injection marker escapes, not
 * a quality score. Corpus sizes (`caseCounts.*`, `retrieval.caseCount`) are deliberately absent —
 * see `flattenMetrics`.
 */
export const GATED_METRICS: readonly { key: string; direction: 'higher' | 'lower' }[] = [
  { key: 'retrieval.recallAt5', direction: 'higher' },
  { key: 'retrieval.recallAt10', direction: 'higher' },
  { key: 'retrieval.mrr', direction: 'higher' },
  { key: 'citationPrecision', direction: 'higher' },
  { key: 'claimCoverageMean', direction: 'higher' },
  { key: 'abstentionAccuracy', direction: 'higher' },
  { key: 'conflictRecall', direction: 'higher' },
  { key: 'answerContentAccuracy', direction: 'higher' },
  { key: 'conflictScopeAccuracy', direction: 'higher' },
  { key: 'canaryOwnVoiceLeakRate', direction: 'lower' },
  { key: 'canaryVerifiedQuoteLeakRate', direction: 'lower' },
];

/** Dotted-key paths never surfaced by `flattenMetrics`: corpus sizes, not quality — comparing a
 * case count against a baseline case count would gate on the fixture set changing, not on the
 * system under test regressing. */
const EXCLUDED_PATHS = new Set(['retrieval.caseCount']);
const EXCLUDED_PREFIXES = ['caseCounts.'];

/**
 * Flattens a metrics object (nested, e.g. `retrieval.recallAt5`) into dotted-key leaves, skipping
 * `caseCounts.*` and `retrieval.caseCount` entirely (see `EXCLUDED_PATHS`/`EXCLUDED_PREFIXES`) and
 * any leaf that is not a finite number — a metric a future run adds with no numeric value yet
 * should be silently absent from comparison, not surfaced as `NaN`/`Infinity`.
 */
export function flattenMetrics(metrics: Partial<EvalMetrics>): Record<string, number> {
  const flat: Record<string, number> = {};

  const walk = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (
        EXCLUDED_PATHS.has(path) ||
        EXCLUDED_PREFIXES.some((prefixPath) => path.startsWith(prefixPath))
      ) {
        continue;
      }
      if (typeof child === 'number') {
        if (Number.isFinite(child)) {
          flat[path] = child;
        }
        continue;
      }
      walk(child, path);
    }
  };

  walk(metrics, '');
  return flat;
}

export interface BaselineComparison {
  readonly regressions: readonly { metric: string; baseline: number; current: number }[];
  readonly held: readonly string[];
  readonly absentFromBaseline: readonly string[];
  readonly absentFromCurrent: readonly string[];
}

/**
 * Compares `current` against a flattened baseline over `GATED_METRICS` only. A gated key present
 * on both sides regresses when its declared direction says so — `higher` and `current < baseline`,
 * or `lower` and `current > baseline`, epsilon 0 — and a regression is meant to fail the run
 * CLOSED (`eval/run.ts` sets `process.exitCode = 1` on a nonempty `regressions`). A key present on
 * only one side is reported, never gated: `absentFromBaseline`/`absentFromCurrent` describe a
 * metric that was added or removed between runs, which is not by itself a quality regression.
 */
export function compareToBaseline(
  current: EvalMetrics,
  baselineFlat: Record<string, number>,
): BaselineComparison {
  const currentFlat = flattenMetrics(current);
  const regressions: { metric: string; baseline: number; current: number }[] = [];
  const held: string[] = [];
  const absentFromBaseline: string[] = [];
  const absentFromCurrent: string[] = [];

  for (const { key, direction } of GATED_METRICS) {
    const inBaseline = key in baselineFlat;
    const inCurrent = key in currentFlat;

    if (!inCurrent) {
      absentFromCurrent.push(key);
      continue;
    }
    if (!inBaseline) {
      absentFromBaseline.push(key);
      continue;
    }

    const baselineValue = baselineFlat[key];
    const currentValue = currentFlat[key];
    const regressed =
      direction === 'higher' ? currentValue < baselineValue : currentValue > baselineValue;
    if (regressed) {
      regressions.push({ metric: key, baseline: baselineValue, current: currentValue });
    } else {
      held.push(key);
    }
  }

  return { regressions, held, absentFromBaseline, absentFromCurrent };
}

const BaselineFileSchema = z.object({
  sourceGitSha: z.string(),
  generatedAt: z.string(),
  metrics: z.record(z.string(), z.unknown()),
});

export interface BaselineFile {
  readonly sourceGitSha: string;
  readonly generatedAt: string;
  readonly metrics: Record<string, number>;
}

/**
 * Reads and parses a committed baseline file (`eval/baseline/*.json`), then flattens `metrics` the
 * same way `compareToBaseline` flattens the current run — so the two sides of a comparison always
 * go through one flattening rule. Throws a message naming `path` on any shape failure, since a
 * malformed baseline should stop the run loudly rather than compare against a partially-parsed
 * object.
 */
export async function readBaselineFile(path: string): Promise<BaselineFile> {
  const raw = await readFile(path, 'utf-8');
  const parsed = BaselineFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `eval: baseline file '${path}' does not match the expected shape — ${parsed.error.message}`,
    );
  }
  return {
    sourceGitSha: parsed.data.sourceGitSha,
    generatedAt: parsed.data.generatedAt,
    metrics: flattenMetrics(parsed.data.metrics),
  };
}
