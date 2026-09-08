import { ANTHROPIC_PRICING } from '../../../src/providers/model/anthropic-pricing.table';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import type {
  CorpusFiling,
  CorpusManifest,
} from '../../../scripts/public-corpus/lib/corpus-manifest';
import {
  analyticCostModel,
  walkSelection,
  type CostModel,
  type FileSizing,
} from '../../../scripts/public-corpus/lib/extrapolate-corpus';

const ALLOWLIST = {
  registrants: [
    { cik: '0000000001', name: 'Alpha Corp' },
    { cik: '0000000002', name: 'Beta Trust' },
  ],
  forms: ['10-K', '10-Q'],
  filedFrom: '2024-01-01',
  filedTo: '2025-12-31',
  exhibitIncludeHints: ['ex99'],
  fileExtensions: ['htm'],
};

function buildFiling(overrides: Partial<CorpusFiling> = {}): CorpusFiling {
  return {
    cik: '0000000001',
    registrant: 'Alpha Corp',
    accession: '0000000001-25-000001',
    form: '10-K',
    filingDate: '2025-01-01',
    reportDate: null,
    primaryDocument: 'a.htm',
    selected: false,
    files: [],
    ...overrides,
  };
}

function buildManifest(filings: readonly CorpusFiling[]): CorpusManifest {
  return { schemaVersion: 1, allowlist: ALLOWLIST, registrants: [], filings };
}

function buildFile(overrides: Partial<FileSizing> = {}): FileSizing {
  return {
    path: '0000000001/000000000125000001/a.htm',
    cik: '0000000001',
    accession: '0000000001-25-000001',
    form: '10-K',
    role: 'primary',
    elements: 10,
    chunks: 10,
    proseChunks: 10,
    tableChunks: 0,
    tokens: 700,
    numericTokens: 5,
    ...overrides,
  };
}

const FLAT_COST: CostModel = {
  usdPerProseChunk: 1,
  secondsPerProseChunk: 3600,
  source: 'analytic',
};

describe('analyticCostModel', () => {
  it('prices dollars across every pass and seconds across one, divided by concurrency', () => {
    const model = analyticCostModel('claude-sonnet-5', ANTHROPIC_PRICING, 3, 2000, 400, 2, 5);

    // 3 passes * (2000 * $3/M + 400 * $15/M) = 3 * (0.006 + 0.006) = 0.036.
    expect(model.usdPerProseChunk).toBeCloseTo(0.036, 6);
    // Passes run concurrently per chunk (Promise.allSettled), so wall-clock per chunk is one
    // pass's duration divided by how many chunks run at once, not multiplied by pass count.
    expect(model.secondsPerProseChunk).toBeCloseTo(2.5, 6);
    expect(model.source).toBe('analytic');
  });

  it('throws for a model absent from the pricing table', () => {
    expect(() => analyticCostModel('unknown-model', ANTHROPIC_PRICING, 3, 2000, 400, 2, 5)).toThrow(
      UnknownModelPricingError,
    );
  });
});

describe('walkSelection', () => {
  it('stops before the filing that would breach maxChunks', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001' }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2024-06-01' }),
    ]);
    const files = [
      buildFile({ accession: '0000000001-25-000001', chunks: 6000, proseChunks: 6000 }),
      buildFile({ accession: '0000000001-25-000002', chunks: 6000, proseChunks: 6000 }),
    ];

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 10000, maxSpendUsd: 1e9, maxHours: 1e9 },
      FLAT_COST,
    );

    expect(result.stoppedBy).toBe('maxChunks');
    expect(result.totals.chunks).toBe(6000);
    expect(result.walk).toHaveLength(1);
    expect(result.walk[0].accession).toBe('0000000001-25-000001');
  });

  it('stops before the filing that would breach maxSpendUsd', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001' }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2024-06-01' }),
    ]);
    const files = [
      buildFile({ accession: '0000000001-25-000001', chunks: 10, proseChunks: 10 }),
      buildFile({ accession: '0000000001-25-000002', chunks: 10, proseChunks: 10 }),
    ];
    const cost: CostModel = { usdPerProseChunk: 1, secondsPerProseChunk: 0, source: 'analytic' };

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 1e9, maxSpendUsd: 10, maxHours: 1e9 },
      cost,
    );

    expect(result.stoppedBy).toBe('maxSpendUsd');
    expect(result.totals.spendUsd).toBe(10);
  });

  it('stops before the filing that would breach maxHours', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001' }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2024-06-01' }),
    ]);
    const files = [
      buildFile({ accession: '0000000001-25-000001', chunks: 10, proseChunks: 10 }),
      buildFile({ accession: '0000000001-25-000002', chunks: 10, proseChunks: 10 }),
    ];
    const cost: CostModel = { usdPerProseChunk: 0, secondsPerProseChunk: 360, source: 'analytic' };

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 1e9, maxSpendUsd: 1e9, maxHours: 1 },
      cost,
    );

    expect(result.stoppedBy).toBe('maxHours');
    expect(result.totals.hours).toBeCloseTo(1, 6);
  });

  it("reports 'exhausted' when every filing fits inside every bound", () => {
    const manifest = buildManifest([buildFiling()]);
    const files = [buildFile()];

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 1e9, maxSpendUsd: 1e9, maxHours: 1e9 },
      FLAT_COST,
    );

    expect(result.stoppedBy).toBe('exhausted');
    expect(result.totals.documents).toBe(1);
  });

  it('orders the walk by registrant allowlist order, then filingDate descending, then 10-K before 10-Q', () => {
    const manifest = buildManifest([
      buildFiling({
        cik: '0000000002',
        registrant: 'Beta Trust',
        accession: '0000000002-25-000001',
        filingDate: '2025-06-01',
      }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2025-01-01', form: '10-Q' }),
      buildFiling({ accession: '0000000001-25-000001', filingDate: '2025-01-01', form: '10-K' }),
    ]);
    const files = [
      buildFile({ cik: '0000000002', accession: '0000000002-25-000001' }),
      buildFile({ accession: '0000000001-25-000002', form: '10-Q' }),
      buildFile({ accession: '0000000001-25-000001', form: '10-K' }),
    ];

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 1e9, maxSpendUsd: 1e9, maxHours: 1e9 },
      FLAT_COST,
    );

    expect(result.walk.map((step) => step.accession)).toEqual([
      '0000000001-25-000001',
      '0000000001-25-000002',
      '0000000002-25-000001',
    ]);
  });

  it('derives a conservative selection: only registrants the walk finished entirely count, capped to their smallest per-form count', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001', form: '10-K' }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2024-06-01', form: '10-Q' }),
      buildFiling({
        cik: '0000000002',
        registrant: 'Beta Trust',
        accession: '0000000002-25-000001',
        form: '10-K',
      }),
    ]);
    const files = [
      buildFile({ accession: '0000000001-25-000001', form: '10-K', chunks: 10, proseChunks: 10 }),
      buildFile({ accession: '0000000001-25-000002', form: '10-Q', chunks: 10, proseChunks: 10 }),
      // Breaches the bound, so registrant 2 (Beta Trust) is never fully represented.
      buildFile({
        cik: '0000000002',
        accession: '0000000002-25-000001',
        form: '10-K',
        chunks: 1000,
        proseChunks: 1000,
      }),
    ];

    const result = walkSelection(
      files,
      manifest,
      { maxChunks: 25, maxSpendUsd: 1e9, maxHours: 1e9 },
      FLAT_COST,
    );

    expect(result.selection.registrantCount).toBe(1);
    expect(result.selection.maxFilingsPerRegistrantPerForm).toBe(1);
    expect(result.selection.filedFrom).toBe(ALLOWLIST.filedFrom);
    expect(result.selection.filedTo).toBe(ALLOWLIST.filedTo);
  });
});
