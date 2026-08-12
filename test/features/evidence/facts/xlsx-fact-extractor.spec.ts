import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { XlsxCellLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  METRIC_ONTOLOGY,
  type MetricDefinition,
} from '../../../../src/features/evidence/facts/metric-ontology';
import { extractXlsxFacts } from '../../../../src/features/evidence/facts/xlsx-fact-extractor';
import { XlsxParser } from '../../../../src/features/evidence/ingestion/parsers/xlsx.parser';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import rawManifest from '../../../../fixtures/data-room/manifest.json';

const FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/comps.xlsx');

const EXTRACTOR_VERSION = 'xlsx-exceljs-2';

function cellElement(sheetName: string, cell: string, text: string): ParsedElement {
  const locator: XlsxCellLocator = {
    kind: 'xlsx-cell',
    sheetName,
    cell,
    extractorVersion: EXTRACTOR_VERSION,
  };
  return { text, locator, headingPath: [] };
}

function buildRow(
  sheetName: string,
  headerRow: readonly [string, string, ...string[]],
  dataRow: readonly [string, string, ...string[]],
  dataRowNumber: number,
): ParsedElement[] {
  const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const elements: ParsedElement[] = [];
  headerRow.forEach((text, index) =>
    elements.push(cellElement(sheetName, `${columns[index]}1`, text)),
  );
  dataRow.forEach((text, index) =>
    elements.push(cellElement(sheetName, `${columns[index]}${dataRowNumber}`, text)),
  );
  return elements;
}

describe('extractXlsxFacts — real comps.xlsx fixture', () => {
  it('should derive the seeded conflict cell as a cap_rate fact with the manifest value and locator', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);
    const conflictLocation = rawManifest.conflict.locations[0];

    const { accepted } = extractXlsxFacts(parsed.elements, METRIC_ONTOLOGY);
    const capRateFact = accepted.find(
      (fact) =>
        fact.factKey.entity === rawManifest.conflict.property && fact.factKey.metric === 'cap_rate',
    );

    expect(capRateFact).toBeDefined();
    expect(capRateFact?.value).toEqual({ amount: 5.25, unit: 'percent' });
    expect(capRateFact?.locator).toEqual(
      expect.objectContaining({
        kind: 'xlsx-cell',
        sheetName: conflictLocation.sheet,
        cell: conflictLocation.cell,
      }),
    );
    expect(capRateFact?.extractionMethod).toBe('regex');
    expect(capRateFact?.confidence).toBe(1);
  });

  // Regression for the diagnosed `price_per_sf` unit bug: a bare currency cell ("$276.10") must
  // resolve to this metric's own declared unit (`usd_per_sf`), not the hardcoded `usd` that made
  // the fact unrecognizable to `normalizeFactValue` and silently unusable for conflict detection.
  it('should derive a price_per_sf fact with the metric-declared usd_per_sf unit, not usd', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted, rejected } = extractXlsxFacts(parsed.elements, METRIC_ONTOLOGY);
    const pricePerSfFact = accepted.find(
      (fact) =>
        fact.factKey.entity === 'Northgate Business Park' && fact.factKey.metric === 'price_per_sf',
    );

    expect(pricePerSfFact?.value).toEqual({ amount: 276.1, unit: 'usd_per_sf' });
    expect(rejected).toEqual([]);
  });

  it('should derive the same entity+period key for every metric column on one row', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted } = extractXlsxFacts(parsed.elements, METRIC_ONTOLOGY);
    const northgateFacts = accepted.filter(
      (fact) => fact.factKey.entity === 'Northgate Business Park',
    );

    // sale_price, price_per_sf, cap_rate, building_area_sf, net_operating_income
    expect(northgateFacts).toHaveLength(5);
    expect(new Set(northgateFacts.map((fact) => fact.factKey.period))).toEqual(
      new Set(['2025-03']),
    );
  });

  it('should not produce a fact for the Notes column', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted } = extractXlsxFacts(parsed.elements, METRIC_ONTOLOGY);

    expect(accepted.some((fact) => (fact.locator as XlsxCellLocator).cell === 'H2')).toBe(false);
  });

  it('should produce facts for all ten comp rows', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted } = extractXlsxFacts(parsed.elements, METRIC_ONTOLOGY);
    const entities = new Set(accepted.map((fact) => fact.factKey.entity));

    expect(entities.size).toBe(10);
  });
});

describe('extractXlsxFacts — synthetic edge cases', () => {
  const headerRow = [
    'Property Name',
    'Sale Date',
    'Building Area (SF)',
    'Sale Price (USD)',
    'Notes',
  ] as const;

  it('should parse a magnitude-suffixed currency cell into the matching unit', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', '100,000', '$12.0M', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);
    const salePrice = accepted.find((fact) => fact.factKey.metric === 'sale_price');

    expect(salePrice?.value).toEqual({ amount: 12, unit: 'usd_millions' });
  });

  it("should resolve a bare currency cell to its metric's own declared unit, not a hardcoded usd", () => {
    const pricePerSfHeader = ['Property Name', 'Price per SF (USD)'] as const;
    const elements = buildRow('Sheet1', pricePerSfHeader, ['Acme Tower', '$250.00'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted[0].value).toEqual({ amount: 250, unit: 'usd_per_sf' });
    expect(rejected).toEqual([]);
  });

  it('should drop a magnitude suffix the metric has no unit for, rather than guess', () => {
    const pricePerSfHeader = ['Property Name', 'Price per SF (USD)'] as const;
    const elements = buildRow('Sheet1', pricePerSfHeader, ['Acme Tower', '$1.2M'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    // A silent parse-drop (parseCurrencyDisplay returns undefined), not a rejection — this metric
    // never gets far enough to have a `value` to validate against its declared units.
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('should drop a row with no entity-column value', () => {
    const elements = buildRow('Sheet1', headerRow, ['', '2025-01-15', '100,000', '$1,000', ''], 2);

    expect(extractXlsxFacts(elements, METRIC_ONTOLOGY)).toEqual({ accepted: [], rejected: [] });
  });

  it('should derive the undated sentinel when the sheet has no period column', () => {
    const noDateHeader = ['Property Name', 'Building Area (SF)', 'Notes'] as const;
    const elements = buildRow('Sheet1', noDateHeader, ['Acme Tower', '100,000', ''], 2);

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.period).toBe('undated');
  });

  it('should drop a cell that cannot be parsed as a number for its metric type', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', 'not a number', '$1,000', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted.some((fact) => fact.factKey.metric === 'building_area_sf')).toBe(false);
  });

  it('should drop a currency cell with an unrecognized magnitude suffix', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', '100,000', '$1,000x', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted.some((fact) => fact.factKey.metric === 'sale_price')).toBe(false);
  });

  it('should treat a ratio-metric cell with no "%" as an already-fractional value', () => {
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '0.0525'], 2);

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted[0].value).toEqual({ amount: 0.0525, unit: 'ratio' });
  });

  it('should reject a candidate whose parsed unit is not declared by its metric', () => {
    // A contrived ontology entry — its `valueType` says 'percentage' but its `units` list omits
    // both `percent` and `ratio`, so `parsePercentageDisplay`'s output (always one of those two
    // ids) can never satisfy it. Exercises the final validate-and-reject step generically, for any
    // future extractor/ontology drift, not just the price_per_sf/base_rent_psf case it was
    // diagnosed from.
    const misconfiguredOntology: MetricDefinition[] = [
      {
        id: 'cap_rate',
        label: 'Cap Rate',
        aliases: ['Cap Rate'],
        valueType: 'percentage',
        canonicalUnit: 'bps',
        units: [{ id: 'bps', toCanonicalFactor: 0.0001 }],
        toleranceKind: 'absolute',
        tolerance: 0.0025,
      },
    ];
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '5.25%'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, misconfiguredOntology);

    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].factKey).toEqual({
      entity: 'Acme Tower',
      metric: 'cap_rate',
      period: 'undated',
    });
    expect(rejected[0].value).toEqual({ amount: 5.25, unit: 'percent' });
    expect(rejected[0].reason).toBe("unit 'percent' is not valid for metric 'cap_rate'");
    expect(rejected[0].locator).toEqual(expect.objectContaining({ kind: 'xlsx-cell', cell: 'B2' }));
  });

  it('should return no facts for an empty element list', () => {
    expect(extractXlsxFacts([], METRIC_ONTOLOGY)).toEqual({ accepted: [], rejected: [] });
  });

  it('should skip a non-xlsx-cell element without throwing', () => {
    const elements: ParsedElement[] = [
      {
        text: 'some prose',
        locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
        headingPath: [],
      },
    ];

    expect(extractXlsxFacts(elements, METRIC_ONTOLOGY)).toEqual({ accepted: [], rejected: [] });
  });

  // Regression for the defect this file exists to fix: a report-layout sheet with a title row
  // above the real header used to have that title row mistaken for the header (the old
  // Math.min-of-occupied-rows assumption), so "Property Name" and "Sale Date" were never
  // recognized as headers and every row below produced zero facts. detectHeaderRow (sheet-header.ts)
  // skips the title and finds row 2 instead.
  it('should derive facts from a report-layout sheet whose real header sits below a title row', () => {
    const elements = [
      cellElement('Sheet1', 'A1', 'Q1 2025 Comparable Sales Report'),
      cellElement('Sheet1', 'A2', 'Property Name'),
      cellElement('Sheet1', 'B2', 'Sale Date'),
      cellElement('Sheet1', 'C2', 'Building Area (SF)'),
      cellElement('Sheet1', 'A3', 'Acme Tower'),
      cellElement('Sheet1', 'B3', '2025-01-15'),
      cellElement('Sheet1', 'C3', '100,000'),
    ];

    const { accepted } = extractXlsxFacts(elements, METRIC_ONTOLOGY);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey).toEqual({
      entity: 'Acme Tower',
      metric: 'building_area_sf',
      period: '2025-01',
    });
    expect(accepted[0].value).toEqual({ amount: 100000, unit: 'sf' });
  });
});
