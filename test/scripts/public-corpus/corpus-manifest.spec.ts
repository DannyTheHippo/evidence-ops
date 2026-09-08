import {
  applySelection,
  manifestSha8,
  selectedFiles,
  sortManifest,
  type CorpusFile,
  type CorpusFiling,
  type CorpusManifest,
} from '../../../scripts/public-corpus/lib/corpus-manifest';

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

function buildFile(overrides: Partial<CorpusFile> = {}): CorpusFile {
  return {
    path: 'b.htm',
    role: 'primary',
    exhibitHint: null,
    sourceUrl: 'https://www.sec.gov/x/b.htm',
    sha256: 'sha-b',
    bytes: 10,
    mimeType: 'text/html',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    duplicateOf: null,
    ...overrides,
  };
}

function buildFiling(overrides: Partial<CorpusFiling> = {}): CorpusFiling {
  return {
    cik: '0000000001',
    registrant: 'Alpha Corp',
    accession: '0000000001-25-000001',
    form: '10-K',
    filingDate: '2025-01-01',
    reportDate: null,
    primaryDocument: 'b.htm',
    selected: false,
    files: [buildFile()],
    ...overrides,
  };
}

function buildManifest(
  filings: readonly CorpusFiling[],
  registrants: CorpusManifest['registrants'] = [],
): CorpusManifest {
  return { schemaVersion: 1, allowlist: ALLOWLIST, registrants, filings };
}

describe('sortManifest', () => {
  it('orders registrants by allowlist order regardless of input order', () => {
    const manifest = buildManifest(
      [],
      [
        {
          cik: '0000000002',
          name: 'Beta Trust',
          companyFacts: { path: 'x', sha256: 'x', bytes: 1 },
        },
        {
          cik: '0000000001',
          name: 'Alpha Corp',
          companyFacts: { path: 'y', sha256: 'y', bytes: 1 },
        },
      ],
    );

    const sorted = sortManifest(manifest);

    expect(sorted.registrants.map((r) => r.cik)).toEqual(['0000000001', '0000000002']);
  });

  it('orders filings by registrant order, then filingDate descending, then accession, and sorts files by path', () => {
    const manifest = buildManifest([
      buildFiling({
        cik: '0000000002',
        registrant: 'Beta Trust',
        accession: '0000000002-25-000001',
        filingDate: '2025-06-01',
      }),
      buildFiling({
        cik: '0000000001',
        accession: '0000000001-25-000002',
        filingDate: '2025-01-01',
      }),
      buildFiling({
        cik: '0000000001',
        accession: '0000000001-25-000001',
        filingDate: '2025-06-01',
        files: [buildFile({ path: 'z.htm' }), buildFile({ path: 'a.htm' })],
      }),
    ]);

    const sorted = sortManifest(manifest);

    expect(sorted.filings.map((f) => f.accession)).toEqual([
      '0000000001-25-000001',
      '0000000001-25-000002',
      '0000000002-25-000001',
    ]);
    expect(sorted.filings[0].files.map((f) => f.path)).toEqual(['a.htm', 'z.htm']);
  });

  it('does not mutate the manifest passed in', () => {
    const manifest = buildManifest([buildFiling()]);
    const original = JSON.parse(JSON.stringify(manifest)) as CorpusManifest;

    sortManifest(manifest);

    expect(manifest).toEqual(original);
  });
});

describe('applySelection', () => {
  it('excludes a registrant beyond registrantCount', () => {
    const manifest = buildManifest([
      buildFiling({ cik: '0000000001' }),
      buildFiling({
        cik: '0000000002',
        registrant: 'Beta Trust',
        accession: '0000000002-25-000001',
      }),
    ]);

    const result = applySelection(manifest, {
      registrantCount: 1,
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
      maxFilingsPerRegistrantPerForm: 10,
    });

    expect(result.filings.find((f) => f.cik === '0000000001')?.selected).toBe(true);
    expect(result.filings.find((f) => f.cik === '0000000002')?.selected).toBe(false);
  });

  it('excludes a filing outside the window', () => {
    const manifest = buildManifest([buildFiling({ filingDate: '2023-12-31' })]);

    const result = applySelection(manifest, {
      registrantCount: 2,
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
      maxFilingsPerRegistrantPerForm: 10,
    });

    expect(result.filings[0].selected).toBe(false);
  });

  it('caps selection at maxFilingsPerRegistrantPerForm per (registrant, form), in walk order', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000003', filingDate: '2025-03-01' }),
      buildFiling({ accession: '0000000001-25-000002', filingDate: '2025-02-01' }),
      buildFiling({ accession: '0000000001-25-000001', filingDate: '2025-01-01' }),
    ]);

    const result = applySelection(manifest, {
      registrantCount: 2,
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
      maxFilingsPerRegistrantPerForm: 2,
    });

    expect(result.filings.map((f) => f.selected)).toEqual([true, true, false]);
  });

  it('does not mutate the manifest passed in', () => {
    const manifest = buildManifest([buildFiling()]);
    const original = JSON.parse(JSON.stringify(manifest)) as CorpusManifest;

    applySelection(manifest, {
      registrantCount: 2,
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
      maxFilingsPerRegistrantPerForm: 1,
    });

    expect(manifest).toEqual(original);
  });
});

describe('selectedFiles', () => {
  it('excludes files from an unselected filing and files marked duplicateOf', () => {
    const manifest = buildManifest([
      buildFiling({
        selected: true,
        files: [
          buildFile({ path: 'primary.htm' }),
          buildFile({ path: 'dup.htm', duplicateOf: 'primary.htm' }),
        ],
      }),
      buildFiling({ accession: '0000000001-25-000002', selected: false }),
    ]);

    const files = selectedFiles(manifest);

    expect(files.map((f) => f.path)).toEqual(['primary.htm']);
    expect(files[0].cik).toBe('0000000001');
  });
});

describe('manifestSha8', () => {
  it('is stable across key order', () => {
    const manifest = buildManifest([buildFiling()]);
    const reordered: CorpusManifest = {
      filings: manifest.filings,
      registrants: manifest.registrants,
      allowlist: manifest.allowlist,
      schemaVersion: manifest.schemaVersion,
    };

    expect(manifestSha8(reordered)).toBe(manifestSha8(manifest));
  });

  it('is exactly 8 hex characters and differs across different content', () => {
    const manifest = buildManifest([buildFiling()]);
    const other = buildManifest([buildFiling({ accession: '0000000001-25-000099' })]);

    expect(manifestSha8(manifest)).toMatch(/^[0-9a-f]{8}$/);
    expect(manifestSha8(manifest)).not.toBe(manifestSha8(other));
  });
});
