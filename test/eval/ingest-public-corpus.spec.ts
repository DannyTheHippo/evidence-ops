import {
  planIngest,
  type IngestLedger,
  type IngestLedgerEntry,
} from '../../eval/ingest-public-corpus';
import type {
  CorpusFile,
  CorpusFiling,
  CorpusManifest,
} from '../../scripts/public-corpus/lib/corpus-manifest';

const ALLOWLIST = {
  registrants: [{ cik: '0000000001', name: 'Alpha Corp' }],
  forms: ['10-K', '10-Q'],
  filedFrom: '2024-01-01',
  filedTo: '2025-12-31',
  exhibitIncludeHints: ['ex99'],
  fileExtensions: ['htm'],
};

function buildFile(overrides: Partial<CorpusFile> = {}): CorpusFile {
  return {
    path: '0000000001/000000000125000001/a.htm',
    role: 'primary',
    exhibitHint: null,
    sourceUrl: 'https://www.sec.gov/x/a.htm',
    sha256: 'sha-a',
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
    primaryDocument: 'a.htm',
    selected: true,
    files: [buildFile()],
    ...overrides,
  };
}

function buildManifest(filings: readonly CorpusFiling[]): CorpusManifest {
  return { schemaVersion: 1, allowlist: ALLOWLIST, registrants: [], filings };
}

function buildLedgerEntry(overrides: Partial<IngestLedgerEntry> = {}): IngestLedgerEntry {
  return {
    path: '0000000001/000000000125000001/a.htm',
    sha256: 'sha-a',
    state: 'ingested',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildLedger(entries: Record<string, IngestLedgerEntry> = {}): IngestLedger {
  return {
    tenantId: 'eval-public',
    corpusManifestSha256: 'deadbeef',
    startedAt: '2026-01-01T00:00:00.000Z',
    entries,
  };
}

describe('planIngest', () => {
  it('should plan every selected path when the ledger is undefined', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001', files: [buildFile({ path: 'a.htm' })] }),
      buildFiling({ accession: '0000000001-25-000002', files: [buildFile({ path: 'b.htm' })] }),
    ]);

    expect(planIngest(manifest, undefined, {})).toEqual(['a.htm', 'b.htm']);
  });

  it('should skip a path already ingested', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);
    const ledger = buildLedger({ 'a.htm': buildLedgerEntry({ path: 'a.htm', state: 'ingested' }) });

    expect(planIngest(manifest, ledger, {})).toEqual([]);
  });

  it('should skip a path already failed', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);
    const ledger = buildLedger({ 'a.htm': buildLedgerEntry({ path: 'a.htm', state: 'failed' }) });

    expect(planIngest(manifest, ledger, {})).toEqual([]);
  });

  it('should retry a path left facts-pending below the attempt cap', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);
    const ledger = buildLedger({
      'a.htm': buildLedgerEntry({ path: 'a.htm', state: 'facts-pending', attempts: 2 }),
    });

    expect(planIngest(manifest, ledger, {})).toEqual(['a.htm']);
  });

  it('should not retry a facts-pending path once it has reached the attempt cap', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);
    const ledger = buildLedger({
      'a.htm': buildLedgerEntry({ path: 'a.htm', state: 'facts-pending', attempts: 3 }),
    });

    expect(planIngest(manifest, ledger, {})).toEqual([]);
  });

  it('should always retry a path left pending, regardless of attempts', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);
    const ledger = buildLedger({
      'a.htm': buildLedgerEntry({ path: 'a.htm', state: 'pending', attempts: 5 }),
    });

    expect(planIngest(manifest, ledger, {})).toEqual(['a.htm']);
  });

  it('should honour --only as a path-prefix filter', () => {
    const manifest = buildManifest([
      buildFiling({
        cik: '0000000001',
        accession: '0000000001-25-000001',
        files: [buildFile({ path: '0000000001/a/x.htm' })],
      }),
      buildFiling({
        cik: '0000000002',
        registrant: 'Beta Trust',
        accession: '0000000002-25-000001',
        files: [buildFile({ path: '0000000002/a/y.htm' })],
      }),
    ]);

    expect(planIngest(manifest, undefined, { only: '0000000002' })).toEqual(['0000000002/a/y.htm']);
  });

  it('should honour --max-documents as a cap on the plan, preserving manifest order', () => {
    const manifest = buildManifest([
      buildFiling({ accession: '0000000001-25-000001', files: [buildFile({ path: 'a.htm' })] }),
      buildFiling({ accession: '0000000001-25-000002', files: [buildFile({ path: 'b.htm' })] }),
      buildFiling({ accession: '0000000001-25-000003', files: [buildFile({ path: 'c.htm' })] }),
    ]);

    expect(planIngest(manifest, undefined, { maxDocuments: 2 })).toEqual(['a.htm', 'b.htm']);
  });

  it('should return an empty plan for --max-documents 0 without treating it as "unset"', () => {
    const manifest = buildManifest([buildFiling({ files: [buildFile({ path: 'a.htm' })] })]);

    expect(planIngest(manifest, undefined, { maxDocuments: 0 })).toEqual([]);
  });

  it('should exclude an unselected filing and a duplicate file, and preserve manifest order over ledger insertion order', () => {
    const manifest = buildManifest([
      buildFiling({
        accession: '0000000001-25-000001',
        files: [buildFile({ path: 'a.htm' }), buildFile({ path: 'dup.htm', duplicateOf: 'a.htm' })],
      }),
      buildFiling({
        accession: '0000000001-25-000002',
        selected: false,
        files: [buildFile({ path: 'z.htm' })],
      }),
    ]);

    expect(planIngest(manifest, undefined, {})).toEqual(['a.htm']);
  });
});
