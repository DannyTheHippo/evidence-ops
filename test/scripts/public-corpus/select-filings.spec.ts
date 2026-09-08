import {
  selectFilings,
  type SubmissionsJson,
} from '../../../scripts/public-corpus/lib/select-filings';

function buildSubmissions(
  recent: Partial<SubmissionsJson['filings']['recent']> = {},
): SubmissionsJson {
  return {
    cik: '0001045609',
    name: 'Prologis, Inc.',
    filings: {
      recent: {
        accessionNumber: [],
        form: [],
        filingDate: [],
        reportDate: [],
        primaryDocument: [],
        ...recent,
      },
    },
  };
}

describe('selectFilings', () => {
  it('reads the columnar arrays index by index', () => {
    const submissions = buildSubmissions({
      accessionNumber: ['0001-25-000001', '0001-25-000002'],
      form: ['10-K', '10-Q'],
      filingDate: ['2025-02-01', '2025-05-01'],
      reportDate: ['2024-12-31', '2025-03-31'],
      primaryDocument: ['prologis-10k.htm', 'prologis-10q.htm'],
    });

    const selected = selectFilings(submissions, {
      forms: ['10-K', '10-Q'],
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
    });

    expect(selected).toEqual([
      {
        accession: '0001-25-000002',
        form: '10-Q',
        filingDate: '2025-05-01',
        reportDate: '2025-03-31',
        primaryDocument: 'prologis-10q.htm',
      },
      {
        accession: '0001-25-000001',
        form: '10-K',
        filingDate: '2025-02-01',
        reportDate: '2024-12-31',
        primaryDocument: 'prologis-10k.htm',
      },
    ]);
  });

  it('excludes an amendment by exact form match', () => {
    const submissions = buildSubmissions({
      accessionNumber: ['0001-25-000001'],
      form: ['10-K/A'],
      filingDate: ['2025-02-01'],
      reportDate: ['2024-12-31'],
      primaryDocument: ['prologis-10ka.htm'],
    });

    const selected = selectFilings(submissions, {
      forms: ['10-K', '10-Q'],
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
    });

    expect(selected).toEqual([]);
  });

  it('excludes filings outside the window and includes the boundary dates', () => {
    const submissions = buildSubmissions({
      accessionNumber: ['0001-23-000001', '0001-24-000001', '0001-25-000001', '0001-26-000001'],
      form: ['10-K', '10-K', '10-K', '10-K'],
      filingDate: ['2023-12-31', '2024-01-01', '2025-12-31', '2026-01-01'],
      reportDate: ['', '', '', ''],
      primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'd.htm'],
    });

    const selected = selectFilings(submissions, {
      forms: ['10-K'],
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
    });

    expect(selected.map((filing) => filing.accession)).toEqual([
      '0001-25-000001',
      '0001-24-000001',
    ]);
  });

  it('normalizes an empty reportDate to null', () => {
    const submissions = buildSubmissions({
      accessionNumber: ['0001-25-000001'],
      form: ['10-K'],
      filingDate: ['2025-02-01'],
      reportDate: [''],
      primaryDocument: ['a.htm'],
    });

    const selected = selectFilings(submissions, {
      forms: ['10-K'],
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
    });

    expect(selected[0].reportDate).toBeNull();
  });

  it('sorts most-recent-first, 10-K before 10-Q on the same date, then by accession', () => {
    const submissions = buildSubmissions({
      accessionNumber: ['0001-25-000002', '0001-25-000001', '0001-24-000001'],
      form: ['10-Q', '10-K', '10-K'],
      filingDate: ['2025-05-01', '2025-05-01', '2024-02-01'],
      reportDate: ['', '', ''],
      primaryDocument: ['q.htm', 'k.htm', 'old-k.htm'],
    });

    const selected = selectFilings(submissions, {
      forms: ['10-K', '10-Q'],
      filedFrom: '2024-01-01',
      filedTo: '2025-12-31',
    });

    expect(selected.map((filing) => filing.accession)).toEqual([
      '0001-25-000001',
      '0001-25-000002',
      '0001-24-000001',
    ]);
  });
});
