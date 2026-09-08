import path from 'node:path';

/**
 * The synthetic lane is the committed, zero-cost replay lane CI runs on every change: its cache and
 * results live under `eval/cache`/`eval/results` and stay tracked in git. The benchmark and public
 * lanes each run against a corpus outside the synthetic fixtures, re-recorded deliberately rather
 * than replayed by default — their cache, and everything under the public lane that could embed a
 * fetched filing's bytes, live under `eval/benchmark/`/`eval/public/`, which `.gitignore` excludes
 * for exactly those pieces so a cache entry can never enter git history by accident. Each lane uses
 * its own tenant so one lane's ingested evidence never mixes with another's.
 */
export type EvalLane = 'synthetic' | 'benchmark' | 'public';

export const EVAL_LANES: readonly EvalLane[] = ['synthetic', 'benchmark', 'public'];

export interface LaneConfig {
  readonly lane: EvalLane;
  readonly tenantId: 'eval' | 'eval-benchmark' | 'eval-public';
  readonly laneRoot: string;
  readonly cacheDir: string;
  readonly modelCacheDir: string;
  readonly embeddingCacheDir: string;
  readonly resultsDir: string;
  readonly datasetPath: string;
  /** Present only for the public lane, whose dataset is frozen against a `casesSha256` before any
   * run — see `scripts/public-corpus/freeze-dataset.ts`. */
  readonly datasetManifestPath?: string;
  readonly corpusDir: string;
  /** Present only for the public lane, whose corpus is fetched rather than committed as fixtures. */
  readonly corpusManifestPath?: string;
  /** Present only for the public lane, whose ingest is resumable and tracked in a ledger. */
  readonly ledgerPath?: string;
  /** Present only for the public lane, which is scored against pre-registered bars rather than the
   * synthetic lane's hard-coded floors. */
  readonly barsPath?: string;
  readonly canarySource: 'fixture-manifest' | 'dataset';
}

export function laneConfig(lane: EvalLane): LaneConfig {
  const laneRoot = lane === 'synthetic' ? __dirname : path.join(__dirname, lane);
  const cacheDir = path.join(laneRoot, 'cache');
  const corpusDir =
    lane === 'synthetic'
      ? path.join(__dirname, '../fixtures/data-room')
      : path.join(laneRoot, 'corpus');

  return {
    lane,
    tenantId:
      lane === 'synthetic' ? 'eval' : lane === 'benchmark' ? 'eval-benchmark' : 'eval-public',
    laneRoot,
    cacheDir,
    modelCacheDir: path.join(cacheDir, 'model'),
    embeddingCacheDir: path.join(cacheDir, 'embedding'),
    resultsDir: path.join(laneRoot, 'results'),
    datasetPath: path.join(laneRoot, 'dataset/cases.json'),
    datasetManifestPath:
      lane === 'public' ? path.join(laneRoot, 'dataset/manifest.json') : undefined,
    corpusDir,
    corpusManifestPath: lane === 'public' ? path.join(laneRoot, 'corpus-manifest.json') : undefined,
    ledgerPath: lane === 'public' ? path.join(corpusDir, 'ingest-ledger.json') : undefined,
    barsPath: lane === 'public' ? path.join(laneRoot, 'bars.json') : undefined,
    canarySource: lane === 'public' ? 'dataset' : 'fixture-manifest',
  };
}
