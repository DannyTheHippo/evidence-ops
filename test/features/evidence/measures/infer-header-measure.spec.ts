import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { FactValueType } from '../../../../src/features/evidence/facts/metric-ontology';
import {
  buildHeaderProposal,
  deriveMeasureSlug,
  inferValueType,
} from '../../../../src/features/evidence/measures/infer-header-measure';
import {
  DEFAULT_TOLERANCE_BY_VALUE_TYPE,
  DEFAULT_UNITS_BY_VALUE_TYPE,
} from '../../../../src/features/evidence/measures/measure-defaults';

const HEADER_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-cell',
  sheetName: 'Sheet1',
  cell: 'B1',
  extractorVersion: 'xlsx-exceljs-2',
};

describe('deriveMeasureSlug', () => {
  const SLUG_TABLE: readonly { readonly header: string; readonly slug: string | undefined }[] = [
    { header: 'Cap Rate', slug: 'cap_rate' },
    { header: 'Sale Price (USD)', slug: 'sale_price' },
    { header: '% Leased', slug: 'leased' },
    { header: 'Year Built', slug: 'year_built' },
    // Bounded at MAX_MEASURE_SLUG_CHARS (64): a header that folds to a longer slug mints none,
    // never a truncated one.
    { header: 'A'.repeat(70), slug: undefined },
    // Folds to the empty string once every character is stripped — fails CLOSED rather than
    // minting a slug with no letters to start it.
    { header: '@@@@@@', slug: undefined },
  ];

  it.each(SLUG_TABLE)('derives $slug from "$header"', ({ header, slug }) => {
    expect(deriveMeasureSlug(header)).toBe(slug);
  });
});

describe('inferValueType', () => {
  const CASES: readonly {
    readonly description: string;
    readonly header: string;
    readonly cellTexts: readonly string[];
    readonly expected: FactValueType;
  }[] = [
    {
      description: 'a header token',
      header: 'Occupancy %',
      cellTexts: ['5.25', '6.1'],
      expected: 'percentage',
    },
    {
      description: 'cell text with no header token',
      header: 'Occupancy',
      cellTexts: ['5.25%', '6.1%'],
      expected: 'percentage',
    },
    {
      description: 'a header token',
      header: 'Sale Price (USD)',
      cellTexts: ['100', '200'],
      expected: 'currency',
    },
    {
      description: 'cell text with no header token',
      header: 'Sale Price',
      cellTexts: ['$100', '$200'],
      expected: 'currency',
    },
    {
      description: 'a header token',
      header: 'Building Area (SF)',
      cellTexts: ['1000', '2000'],
      expected: 'area',
    },
    {
      description: 'a header token',
      header: 'Lease Term (Years)',
      cellTexts: ['5', '10'],
      expected: 'duration',
    },
    {
      description: 'the fallback default with no header token or cell marker',
      header: 'Unit Count',
      cellTexts: ['12', '15'],
      expected: 'count',
    },
  ];

  it.each(CASES)(
    'infers $expected from $description ("$header")',
    ({ header, cellTexts, expected }) => {
      expect(inferValueType(header, cellTexts)).toBe(expected);
    },
  );
});

describe('buildHeaderProposal', () => {
  // Fails CLOSED: a mixed column (mostly numbers with one stray label) is not a measure column.
  it('refuses a column with at least one non-numeric non-empty cell', () => {
    expect(buildHeaderProposal('Unit Count', HEADER_LOCATOR, ['12', 'n/a', '15'])).toBeUndefined();
  });

  it('refuses a column with no non-empty cell', () => {
    expect(buildHeaderProposal('Unit Count', HEADER_LOCATOR, ['', '   '])).toBeUndefined();
  });

  it('refuses a header whose slug cannot be derived', () => {
    expect(buildHeaderProposal('$$$', HEADER_LOCATOR, ['12', '15'])).toBeUndefined();
  });

  it('bounds label, headerText, and the alias entry at 200 characters', () => {
    // The parenthetical is stripped entirely by `deriveMeasureSlug`, so the slug itself stays
    // short ('sale_price') while the raw header text this asserts against stays long.
    const header = `Sale Price (${'x'.repeat(250)})`;
    const expected = header.trim().slice(0, 200);

    const proposal = buildHeaderProposal(header, HEADER_LOCATOR, ['100', '200']);

    expect(proposal?.label).toBe(expected);
    expect(proposal?.headerText).toBe(expected);
    expect(proposal?.aliases).toEqual([expected]);
    expect(proposal?.label.length).toBe(200);
  });

  const DEFAULTS_TABLE: readonly {
    readonly header: string;
    readonly cellTexts: readonly string[];
    readonly valueType: FactValueType;
  }[] = [
    { header: 'Occupancy %', cellTexts: ['5.25', '6.1'], valueType: 'percentage' },
    { header: 'Sale Price (USD)', cellTexts: ['100', '200'], valueType: 'currency' },
    { header: 'Building Area (SF)', cellTexts: ['1000', '2000'], valueType: 'area' },
    { header: 'Lease Term (Years)', cellTexts: ['5', '10'], valueType: 'duration' },
    { header: 'Unit Count', cellTexts: ['12', '15'], valueType: 'count' },
  ];

  it.each(DEFAULTS_TABLE)(
    'applies the $valueType defaults table for canonicalUnit/units/toleranceKind/tolerance',
    ({ header, cellTexts, valueType }) => {
      const proposal = buildHeaderProposal(header, HEADER_LOCATOR, cellTexts);

      expect(proposal?.valueType).toBe(valueType);
      expect(proposal?.canonicalUnit).toBe(DEFAULT_UNITS_BY_VALUE_TYPE[valueType].canonicalUnit);
      expect(proposal?.units).toEqual(DEFAULT_UNITS_BY_VALUE_TYPE[valueType].units);
      expect(proposal?.toleranceKind).toBe(
        DEFAULT_TOLERANCE_BY_VALUE_TYPE[valueType].toleranceKind,
      );
      expect(proposal?.tolerance).toBe(DEFAULT_TOLERANCE_BY_VALUE_TYPE[valueType].tolerance);
    },
  );

  it('uses months as the canonical unit for a duration header naming months specifically', () => {
    const proposal = buildHeaderProposal('Notice Period (Months)', HEADER_LOCATOR, ['3', '6']);

    expect(proposal?.valueType).toBe('duration');
    expect(proposal?.canonicalUnit).toBe('months');
    expect(proposal?.units).toEqual([
      { id: 'months', toCanonicalFactor: 1 },
      { id: 'years', toCanonicalFactor: 12 },
    ]);
  });

  it('carries the header locator and slug through unchanged', () => {
    const proposal = buildHeaderProposal('Cap Rate', HEADER_LOCATOR, ['5.25%']);

    expect(proposal?.slug).toBe('cap_rate');
    expect(proposal?.headerLocator).toBe(HEADER_LOCATOR);
  });
});
