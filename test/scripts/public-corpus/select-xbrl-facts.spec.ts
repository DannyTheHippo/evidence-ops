import { MEASURE_SLUGS } from '../../../scripts/public-corpus/lib/measure-slugs';
import {
  findRestatements,
  selectXbrlFacts,
  type CompanyFactsJson,
  type CompanyFactsUnitEntry,
} from '../../../scripts/public-corpus/lib/select-xbrl-facts';
import { XBRL_CONCEPTS } from '../../../scripts/public-corpus/lib/xbrl-concepts';

function buildEntry(overrides: Partial<CompanyFactsUnitEntry> = {}): CompanyFactsUnitEntry {
  return {
    end: '2024-12-31',
    val: 1000,
    accn: '0001045609-25-000001',
    fy: 2024,
    fp: 'FY',
    form: '10-K',
    filed: '2025-02-01',
    ...overrides,
  };
}

function buildCompanyFacts(entries: readonly CompanyFactsUnitEntry[]): CompanyFactsJson {
  return {
    cik: 1045609,
    entityName: 'Prologis, Inc.',
    facts: {
      'us-gaap': {
        Revenues: { units: { USD: entries } },
      },
    },
  };
}

describe('XBRL_CONCEPTS', () => {
  it('covers every MEASURE_SLUGS entry exactly once', () => {
    const slugs = XBRL_CONCEPTS.map((concept) => concept.measureSlug).sort();
    expect(slugs).toEqual([...MEASURE_SLUGS].sort());
    expect(new Set(slugs).size).toBe(MEASURE_SLUGS.length);
  });
});

describe('selectXbrlFacts', () => {
  it('excludes an accession outside accessionsInCorpus', () => {
    const companyFacts = buildCompanyFacts([
      buildEntry({ accn: '0001045609-25-000001' }),
      buildEntry({ accn: '0001045609-25-000002' }),
    ]);

    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001']),
      XBRL_CONCEPTS,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0].accession).toBe('0001045609-25-000001');
  });

  it('dedupes a literal repeat of the same (concept, accession, start, end)', () => {
    const companyFacts = buildCompanyFacts([
      buildEntry({ accn: '0001045609-25-000001', val: 1000 }),
      buildEntry({ accn: '0001045609-25-000001', val: 1000 }),
    ]);

    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001']),
      XBRL_CONCEPTS,
    );

    expect(facts).toHaveLength(1);
  });

  it('keeps the same period reported by two different accessions as two facts', () => {
    const companyFacts = buildCompanyFacts([
      buildEntry({ accn: '0001045609-25-000001', val: 1000, form: '10-K' }),
      buildEntry({ accn: '0001045609-25-000002', val: 1000, form: '10-Q' }),
    ]);

    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001', '0001045609-25-000002']),
      XBRL_CONCEPTS,
    );

    expect(facts.map((fact) => fact.accession).sort()).toEqual([
      '0001045609-25-000001',
      '0001045609-25-000002',
    ]);
  });

  it('normalizes a missing start to null', () => {
    const companyFacts = buildCompanyFacts([buildEntry({ start: undefined })]);

    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001']),
      XBRL_CONCEPTS,
    );

    expect(facts[0].start).toBeNull();
  });
});

describe('findRestatements', () => {
  it('flags a period reported with two different values across two accessions', () => {
    const companyFacts = buildCompanyFacts([
      buildEntry({ accn: '0001045609-25-000001', val: 1000, form: '10-K' }),
      buildEntry({ accn: '0001045609-25-000002', val: 1100, form: '10-Q' }),
    ]);
    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001', '0001045609-25-000002']),
      XBRL_CONCEPTS,
    );

    const restatements = findRestatements(facts);

    expect(restatements).toHaveLength(1);
    expect(restatements[0].values.map((v) => v.val).sort()).toEqual([1000, 1100]);
  });

  it('does not flag the same period reported with the same value twice', () => {
    const companyFacts = buildCompanyFacts([
      buildEntry({ accn: '0001045609-25-000001', val: 1000 }),
      buildEntry({ accn: '0001045609-25-000002', val: 1000 }),
    ]);
    const facts = selectXbrlFacts(
      companyFacts,
      '0001045609',
      new Set(['0001045609-25-000001', '0001045609-25-000002']),
      XBRL_CONCEPTS,
    );

    expect(findRestatements(facts)).toEqual([]);
  });
});
