import path from 'node:path';
import { EVAL_LANES, laneConfig } from '../../eval/lanes';

const EVAL_DIR = path.join(__dirname, '..', '..', 'eval');

describe('EVAL_LANES', () => {
  it('should list exactly the three lanes, synthetic first', () => {
    expect(EVAL_LANES).toEqual(['synthetic', 'benchmark', 'public']);
  });
});

describe('laneConfig', () => {
  it("should scope the synthetic lane to the 'eval' tenant, the tracked eval/ root and the fixtures corpus", () => {
    const config = laneConfig('synthetic');

    expect(config.tenantId).toBe('eval');
    expect(config.laneRoot).toBe(EVAL_DIR);
    expect(config.cacheDir).toBe(path.join(EVAL_DIR, 'cache'));
    expect(config.modelCacheDir).toBe(path.join(EVAL_DIR, 'cache', 'model'));
    expect(config.embeddingCacheDir).toBe(path.join(EVAL_DIR, 'cache', 'embedding'));
    expect(config.resultsDir).toBe(path.join(EVAL_DIR, 'results'));
    expect(config.datasetPath).toBe(path.join(EVAL_DIR, 'dataset', 'cases.json'));
    expect(config.corpusDir).toBe(path.join(EVAL_DIR, '..', 'fixtures', 'data-room'));
    expect(config.canarySource).toBe('fixture-manifest');
    expect(config.datasetManifestPath).toBeUndefined();
    expect(config.corpusManifestPath).toBeUndefined();
    expect(config.ledgerPath).toBeUndefined();
    expect(config.barsPath).toBeUndefined();
  });

  it("should scope the benchmark lane to the 'eval-benchmark' tenant and its own gitignored root", () => {
    const config = laneConfig('benchmark');
    const laneRoot = path.join(EVAL_DIR, 'benchmark');

    expect(config.tenantId).toBe('eval-benchmark');
    expect(config.laneRoot).toBe(laneRoot);
    expect(config.cacheDir).toBe(path.join(laneRoot, 'cache'));
    expect(config.resultsDir).toBe(path.join(laneRoot, 'results'));
    expect(config.datasetPath).toBe(path.join(laneRoot, 'dataset', 'cases.json'));
    expect(config.corpusDir).toBe(path.join(laneRoot, 'corpus'));
    expect(config.canarySource).toBe('fixture-manifest');
    expect(config.datasetManifestPath).toBeUndefined();
    expect(config.corpusManifestPath).toBeUndefined();
    expect(config.ledgerPath).toBeUndefined();
    expect(config.barsPath).toBeUndefined();
  });

  it("should scope the public lane to the 'eval-public' tenant, its dataset manifest, corpus manifest, ledger and bars", () => {
    const config = laneConfig('public');
    const laneRoot = path.join(EVAL_DIR, 'public');

    expect(config.tenantId).toBe('eval-public');
    expect(config.laneRoot).toBe(laneRoot);
    expect(config.cacheDir).toBe(path.join(laneRoot, 'cache'));
    expect(config.resultsDir).toBe(path.join(laneRoot, 'results'));
    expect(config.datasetPath).toBe(path.join(laneRoot, 'dataset', 'cases.json'));
    expect(config.datasetManifestPath).toBe(path.join(laneRoot, 'dataset', 'manifest.json'));
    expect(config.corpusDir).toBe(path.join(laneRoot, 'corpus'));
    expect(config.corpusManifestPath).toBe(path.join(laneRoot, 'corpus-manifest.json'));
    expect(config.ledgerPath).toBe(path.join(laneRoot, 'corpus', 'ingest-ledger.json'));
    expect(config.barsPath).toBe(path.join(laneRoot, 'bars.json'));
    expect(config.canarySource).toBe('dataset');
  });
});
