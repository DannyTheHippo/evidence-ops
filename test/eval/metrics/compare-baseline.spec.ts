import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATED_METRICS,
  compareToBaseline,
  flattenMetrics,
  readBaselineFile,
} from '../../../eval/metrics/compare-baseline';
import type { EvalMetrics } from '../../../eval/metrics/compute-metrics';

function baseMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    retrieval: { recallAt5: 0.8, recallAt10: 0.9, mrr: 0.75, caseCount: 10 },
    citationPrecision: 0.9,
    claimCoverageMean: 0.85,
    abstentionAccuracy: 1,
    conflictRecall: 1,
    canaryOwnVoiceLeakRate: 0,
    canaryVerifiedQuoteLeakRate: 0,
    answerContentAccuracy: 0.95,
    conflictScopeAccuracy: 1,
    tabularGroundedRate: 0.7,
    tabularClaimCount: 20,
    coverageDropRate: 0.1,
    contradictionDropRate: 0.05,
    ledgerResolvedRate: 0,
    ledgerGateSurvivalRate: 0,
    answerRate: 0.9,
    caseCounts: { total: 32, answerable: 12, unanswerable: 8, conflicting: 5, adversarial: 7 },
    ...overrides,
  };
}

/** Reads a gated metric's current value out of `EvalMetrics` by its dotted `GATED_METRICS` key,
 * so a test can move that exact value without hand-writing a nested-object patch per metric. */
function readGatedValue(metrics: EvalMetrics, key: string): number {
  return key
    .split('.')
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], metrics) as number;
}

/** Returns a copy of `metrics` with the gated metric at `key` moved by `delta` — mirrors
 * `readGatedValue`'s dotted-path walk, but writes instead of reads. */
function withGatedValue(metrics: EvalMetrics, key: string, delta: number): EvalMetrics {
  const path = key.split('.');
  if (path.length === 1) {
    return { ...metrics, [path[0]]: readGatedValue(metrics, key) + delta };
  }
  const [outer, inner] = path;
  return {
    ...metrics,
    [outer]: {
      ...(metrics as unknown as Record<string, Record<string, number>>)[outer],
      [inner]: readGatedValue(metrics, key) + delta,
    },
  };
}

describe('compareToBaseline', () => {
  it.each(GATED_METRICS)('holds %s when current equals the baseline', ({ key }) => {
    const metrics = baseMetrics();
    const baselineFlat = flattenMetrics(metrics);

    const comparison = compareToBaseline(metrics, baselineFlat);

    expect(comparison.held).toContain(key);
    expect(comparison.regressions.map((r) => r.metric)).not.toContain(key);
  });

  it.each(GATED_METRICS)('holds %s on a 0.001 move in its good direction', ({ key, direction }) => {
    const baseline = baseMetrics();
    const baselineFlat = flattenMetrics(baseline);
    const delta = direction === 'higher' ? 0.001 : -0.001;
    const current = withGatedValue(baseline, key, delta);

    const comparison = compareToBaseline(current, baselineFlat);

    expect(comparison.held).toContain(key);
    expect(comparison.regressions.map((r) => r.metric)).not.toContain(key);
  });

  it.each(GATED_METRICS)(
    'regresses %s on a 0.001 move in its bad direction',
    ({ key, direction }) => {
      const baseline = baseMetrics();
      const baselineFlat = flattenMetrics(baseline);
      const delta = direction === 'higher' ? -0.001 : 0.001;
      const current = withGatedValue(baseline, key, delta);

      const comparison = compareToBaseline(current, baselineFlat);

      expect(comparison.regressions.map((r) => r.metric)).toContain(key);
      expect(comparison.held).not.toContain(key);
    },
  );

  it.each(GATED_METRICS)(
    'reports %s as absentFromBaseline when the baseline lacks it',
    ({ key }) => {
      const current = baseMetrics();
      const baselineFlat = flattenMetrics(current);
      delete baselineFlat[key];

      const comparison = compareToBaseline(current, baselineFlat);

      expect(comparison.absentFromBaseline).toContain(key);
      expect(comparison.regressions.map((r) => r.metric)).not.toContain(key);
      expect(comparison.held).not.toContain(key);
    },
  );

  it('reports a gated metric as absentFromCurrent when current lacks it', () => {
    const baseline = baseMetrics();
    const baselineFlat = flattenMetrics(baseline);
    // `retrieval.mrr` missing from `current` — not a legitimate `EvalMetrics` shape (every field
    // is always populated by `computeMetrics`), but `compareToBaseline` must still degrade to
    // reporting rather than throwing: `current` is typed `EvalMetrics`, so this is exercised via a
    // cast, mirroring a future field genuinely being dropped from the type.
    const sparseCurrent = {
      ...baseline,
      retrieval: { recallAt5: 0.8, recallAt10: 0.9 },
    } as unknown as EvalMetrics;

    const comparison = compareToBaseline(sparseCurrent, baselineFlat);

    expect(comparison.absentFromCurrent).toContain('retrieval.mrr');
    expect(comparison.regressions.map((r) => r.metric)).not.toContain('retrieval.mrr');
    expect(comparison.held).not.toContain('retrieval.mrr');
  });
});

describe('flattenMetrics', () => {
  it('never includes caseCounts.* or retrieval.caseCount', () => {
    const flat = flattenMetrics(baseMetrics());

    expect(Object.keys(flat).some((key) => key.startsWith('caseCounts.'))).toBe(false);
    expect('retrieval.caseCount' in flat).toBe(false);
  });

  it('includes every gated metric for a fully populated EvalMetrics', () => {
    const flat = flattenMetrics(baseMetrics());

    for (const { key } of GATED_METRICS) {
      expect(key in flat).toBe(true);
    }
  });

  it('skips a leaf that is not a finite number', () => {
    const flat = flattenMetrics({
      ...baseMetrics(),
      citationPrecision: Number.NaN,
    });

    expect(flat).not.toHaveProperty('citationPrecision');
  });
});

describe('readBaselineFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-ops-baseline-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a well-formed baseline file and flattens its metrics', async () => {
    const filePath = join(dir, 'baseline.json');
    await writeFile(
      filePath,
      JSON.stringify({
        sourceGitSha: 'abc1234',
        generatedAt: '2026-08-27T11:14:14.896Z',
        metrics: baseMetrics(),
      }),
      'utf-8',
    );

    const baseline = await readBaselineFile(filePath);

    expect(baseline.sourceGitSha).toBe('abc1234');
    expect(baseline.generatedAt).toBe('2026-08-27T11:14:14.896Z');
    expect(baseline.metrics['retrieval.recallAt5']).toBe(0.8);
    expect(baseline.metrics).not.toHaveProperty('caseCounts.total');
  });

  it('rejects a file missing metrics, naming the path', async () => {
    const filePath = join(dir, 'malformed.json');
    await writeFile(
      filePath,
      JSON.stringify({ sourceGitSha: 'abc1234', generatedAt: '2026-08-27T11:14:14.896Z' }),
      'utf-8',
    );

    await expect(readBaselineFile(filePath)).rejects.toThrow(filePath);
  });
});
