import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { XlsxCellLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  METRIC_ONTOLOGY,
  type MetricDefinition,
} from '../../../../src/features/evidence/facts/metric-ontology';
import {
  extractXlsxFacts,
  type XlsxExtractionContext,
} from '../../../../src/features/evidence/facts/xlsx-fact-extractor';
import { MAX_HEADER_PROPOSALS_PER_DOCUMENT } from '../../../../src/features/evidence/measures/infer-header-measure';
import { CsvParser } from '../../../../src/features/evidence/ingestion/parsers/csv.parser';
import { XlsxParser } from '../../../../src/features/evidence/ingestion/parsers/xlsx.parser';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import {
  detectConflicts,
  type FactForConflictScan,
} from '../../../../src/features/evidence/conflicts/detect-conflicts';
import rawManifest from '../../../../fixtures/data-room/manifest.json';

const FIXTURE_PATH = path.join(__dirname, '../../../../fixtures/data-room/comps.xlsx');

const EXTRACTOR_VERSION = 'xlsx-exceljs-2';

/** Every call below reads `METRIC_ONTOLOGY` as its `matchable` set unless it names a different one
 *  explicitly, starts with an empty `rejectedSlugs`, and defaults `proposeFromHeaders` off — the
 *  shared shape most of this file's assertions exercise, with the header-proposal-specific tests
 *  overriding the last two arguments directly. */
function extractionContext(
  matchable: readonly MetricDefinition[] = METRIC_ONTOLOGY,
  proposeFromHeaders = false,
  rejectedSlugs: ReadonlySet<string> = new Set(),
): XlsxExtractionContext {
  return { matchable, rejectedSlugs, proposeFromHeaders };
}

function cellElement(
  sheetName: string,
  cell: string,
  text: string,
  mergeCovered?: true,
): ParsedElement {
  const locator: XlsxCellLocator = {
    kind: 'xlsx-cell',
    sheetName,
    cell,
    extractorVersion: EXTRACTOR_VERSION,
  };
  return { text, locator, headingPath: [], mergeCovered };
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
    const conflictLocation = rawManifest.conflicts[0].locations[0];

    const { accepted } = extractXlsxFacts(parsed.elements, extractionContext());
    const capRateFact = accepted.find(
      (fact) =>
        fact.factKey.entity === rawManifest.conflicts[0].property &&
        fact.factKey.metric === 'cap_rate',
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

    const { accepted, rejected } = extractXlsxFacts(parsed.elements, extractionContext());
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

    const { accepted } = extractXlsxFacts(parsed.elements, extractionContext());
    const northgateFacts = accepted.filter(
      (fact) => fact.factKey.entity === 'Northgate Business Park',
    );

    // sale_price, price_per_sf, cap_rate, building_area_sf, net_operating_income
    expect(northgateFacts).toHaveLength(5);
    expect(new Set(northgateFacts.map((fact) => fact.factKey.period))).toEqual(
      new Set(['2025-03']),
    );
    // The fixture's only date column is "Sale Date" — it feeds `factKey.period` (the coarsened
    // "2025-03" above), never `observedAt`; with no dedicated as-of/recorded column, every fact on
    // the row leaves `observedAt` absent rather than borrowing the sale date.
    expect(northgateFacts.every((fact) => fact.observedAt === undefined)).toBe(true);
  });

  it('should not produce a fact for the Notes column', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted } = extractXlsxFacts(parsed.elements, extractionContext());

    expect(accepted.some((fact) => (fact.locator as XlsxCellLocator).cell === 'H2')).toBe(false);
  });

  it('should produce facts for all ten comp rows', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { accepted } = extractXlsxFacts(parsed.elements, extractionContext());
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

  const asOfHeaderRow = [
    'Property Name',
    'Sale Date',
    'As Of',
    'Building Area (SF)',
    'Sale Price (USD)',
  ] as const;

  it('should parse a magnitude-suffixed currency cell into the matching unit', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', '100,000', '$12.0M', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());
    const salePrice = accepted.find((fact) => fact.factKey.metric === 'sale_price');

    expect(salePrice?.value).toEqual({ amount: 12, unit: 'usd_millions' });
    // "Sale Date" feeds `factKey.period` only; this sheet has no as-of column, so observedAt
    // stays absent.
    expect(salePrice?.observedAt).toBeUndefined();
  });

  it("should resolve a bare currency cell to its metric's own declared unit, not a hardcoded usd", () => {
    const pricePerSfHeader = ['Property Name', 'Price per SF (USD)'] as const;
    const elements = buildRow('Sheet1', pricePerSfHeader, ['Acme Tower', '$250.00'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext());

    expect(accepted[0].value).toEqual({ amount: 250, unit: 'usd_per_sf' });
    expect(rejected).toEqual([]);
  });

  it('should drop a magnitude suffix the metric has no unit for, rather than guess', () => {
    const pricePerSfHeader = ['Property Name', 'Price per SF (USD)'] as const;
    const elements = buildRow('Sheet1', pricePerSfHeader, ['Acme Tower', '$1.2M'], 2);

    const { accepted, rejected, reducedFidelityReasons } = extractXlsxFacts(
      elements,
      extractionContext(),
    );

    // The cell mints no fact, and the drop is visible: a magnitude on a per-square-foot price is a
    // figure the sheet states and this extractor cannot ground, which an operator has to be able to
    // see. There is no `value` on the rejection — the parser refuses before assigning a unit.
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].value).toBeUndefined();
    expect(rejected[0].reason).toContain("magnitude suffix 'm'");
    expect(reducedFidelityReasons.join(' ')).toContain('produced no fact');
  });

  it('should drop a row with no entity-column value', () => {
    const elements = buildRow('Sheet1', headerRow, ['', '2025-01-15', '100,000', '$1,000', ''], 2);

    expect(extractXlsxFacts(elements, extractionContext())).toEqual({
      accepted: [],
      rejected: [],
      reducedFidelityReasons: [],
      proposals: [],
    });
  });

  it('should derive the undated sentinel when the sheet has no period column', () => {
    const noDateHeader = ['Property Name', 'Building Area (SF)', 'Notes'] as const;
    const elements = buildRow('Sheet1', noDateHeader, ['Acme Tower', '100,000', ''], 2);

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.period).toBe('undated');
    // No date column to read from — observedAt stays absent rather than defaulting to anything.
    expect(accepted[0].observedAt).toBeUndefined();
  });

  it('should leave observedAt absent when the sheet has only a period column, even though period is still derived', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', '100,000', '$1,000', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());
    const buildingArea = accepted.find((fact) => fact.factKey.metric === 'building_area_sf');

    // "Sale Date" only feeds `factKey.period` (still derived below) — with no dedicated as-of
    // column, observedAt has nothing to derive from.
    expect(buildingArea?.factKey.period).toBe('2025-01');
    expect(buildingArea?.observedAt).toBeUndefined();
  });

  it('should parse observedAt from a distinct as-of column, separate from the period column', () => {
    const elements = buildRow(
      'Sheet1',
      asOfHeaderRow,
      ['Acme Tower', '2025-01-15', '2025-02-01', '100,000', '$1,000'],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());
    const buildingArea = accepted.find((fact) => fact.factKey.metric === 'building_area_sf');

    expect(buildingArea?.factKey.period).toBe('2025-01');
    expect(buildingArea?.observedAt?.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  it('should leave observedAt absent when the as-of column value is not a real calendar date', () => {
    const elements = buildRow(
      'Sheet1',
      asOfHeaderRow,
      ['Acme Tower', '2025-01-15', '2025-02-30', '100,000', '$1,000'],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());
    const buildingArea = accepted.find((fact) => fact.factKey.metric === 'building_area_sf');

    // February has no 30th — the same parseCalendarDate round-trip guard the period column relies
    // on rejects it here too; the period itself still derives fine from "Sale Date".
    expect(buildingArea?.factKey.period).toBe('2025-01');
    expect(buildingArea?.observedAt).toBeUndefined();
  });

  it('should drop a cell that cannot be parsed as a number for its metric type', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', 'not a number', '$1,000', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted.some((fact) => fact.factKey.metric === 'building_area_sf')).toBe(false);
  });

  it('should drop a currency cell with an unrecognized magnitude suffix', () => {
    const elements = buildRow(
      'Sheet1',
      headerRow,
      ['Acme Tower', '2025-01-15', '100,000', '$1,000x', ''],
      2,
    );

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted.some((fact) => fact.factKey.metric === 'sale_price')).toBe(false);
  });

  it('should treat a ratio-metric cell with no "%" as an already-fractional value', () => {
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '0.0525'], 2);

    const { accepted } = extractXlsxFacts(elements, extractionContext());

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

    const { accepted, rejected } = extractXlsxFacts(
      elements,
      extractionContext(misconfiguredOntology),
    );

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

  it('should skip a cell whose address names a row number no double can represent', () => {
    // `A999…9` is well-formed A1 notation, so the address pattern matches and only the row's own
    // magnitude rules it out — the same one-cell skip a malformed address takes, with every other
    // cell on the sheet still producing its facts.
    const elements = [
      cellElement('Sheet1', 'A1', 'Property Name'),
      cellElement('Sheet1', 'B1', 'Building Area (SF)'),
      cellElement('Sheet1', 'A2', 'Acme Tower'),
      cellElement('Sheet1', 'B2', '100,000'),
      cellElement('Sheet1', `B${'9'.repeat(320)}`, '200,000'),
    ];

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toHaveLength(1);
    expect(accepted[0].value).toEqual({ amount: 100000, unit: 'sf' });
    expect(rejected).toEqual([]);
  });

  it('should return no facts for an empty element list', () => {
    expect(extractXlsxFacts([], extractionContext())).toEqual({
      accepted: [],
      rejected: [],
      reducedFidelityReasons: [],
      proposals: [],
    });
  });

  it('should skip a non-xlsx-cell element without throwing', () => {
    const elements: ParsedElement[] = [
      {
        text: 'some prose',
        locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
        headingPath: [],
      },
    ];

    expect(extractXlsxFacts(elements, extractionContext())).toEqual({
      accepted: [],
      rejected: [],
      reducedFidelityReasons: [],
      proposals: [],
    });
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

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey).toEqual({
      entity: 'Acme Tower',
      metric: 'building_area_sf',
      period: '2025-01',
    });
    expect(accepted[0].value).toEqual({ amount: 100000, unit: 'sf' });
  });
});

describe('extractXlsxFacts — strictPercentUnitResolution', () => {
  it('should stay inert (byte-for-byte) with the flag off: a bare fraction still defaults to ratio', () => {
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '5.25'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext());

    expect(accepted[0].value).toEqual({ amount: 5.25, unit: 'ratio' });
    expect(rejected).toEqual([]);
  });

  // Pins the flag-off inertness claim for the header-marker resolution order too: a
  // "Cap Rate (%)" header matches no alias in METRIC_ONTOLOGY today, and the flag being off means
  // the marker-stripping fallback never runs — so this must keep producing zero facts exactly as
  // it does before the flag exists at all.
  it('should stay inert (byte-for-byte) with the flag off: a "(%)" header still resolves no metric', () => {
    const markerHeader = ['Property Name', 'Cap Rate (%)'] as const;
    const elements = buildRow('Sheet1', markerHeader, ['Acme Tower', '5.25'], 2);

    const { accepted, rejected, proposals } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
    // Asserting `accepted` alone is not enough to pin inertness: a header proposal's candidates
    // are returned under `proposals[].candidates`, not `accepted`, so this suite stayed green
    // while the column was in fact minting facts down that path.
    expect(proposals).toEqual([]);
  });

  // The proposal path is the second route out of this header, and it must be gated exactly as the
  // slug fallback is. Ungated it is the worse of the two: `deriveMeasureSlug` strips the marker to
  // `cap_rate`, which collides with a seeded confirmed measure, so the column's cells are stamped
  // `confirmed` against that measure while having been parsed under a synthetic definition with a
  // different unit table — `5.25` entering the ledger as `5.25 ratio`, 525%, with no proposal for
  // an admin to review.
  it('should propose nothing for a "(%)" header while strict percent resolution is off', () => {
    const markerHeader = ['Property Name', 'Cap Rate (%)'] as const;
    const elements = buildRow('Sheet1', markerHeader, ['Acme Tower', '5.25'], 2);

    const { accepted, rejected, proposals } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(proposals).toEqual([]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
  });

  // The defect the flag exists to fix: `5.25` in a bare "Cap Rate" column, with no '%' anywhere
  // in the cell or the header, is genuinely ambiguous between 525% and 5.25% — defaulting to
  // ratio here is exactly how a Cap Rate column entered as a percent-scale number, unlabeled,
  // becomes a fact at 100x the real value.
  it('should reject an ambiguous bare-fraction percentage cell with the flag on, rather than default to ratio', () => {
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '5.25'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext(), true);

    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].value).toBeUndefined();
    expect(rejected[0].reason).toContain('ambiguous between percent and ratio');
    expect(rejected[0].factKey).toEqual({
      entity: 'Acme Tower',
      metric: 'cap_rate',
      period: 'undated',
    });
  });

  it('should still resolve an explicit "%" in the cell text with the flag on, regardless of the header', () => {
    const ratioHeader = ['Property Name', 'Cap Rate'] as const;
    const elements = buildRow('Sheet1', ratioHeader, ['Acme Tower', '5.25%'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext(), true);

    expect(accepted[0].value).toEqual({ amount: 5.25, unit: 'percent' });
    expect(rejected).toEqual([]);
  });

  it('should resolve a bare fraction via a "(%)" header marker with the flag on', () => {
    const markerHeader = ['Property Name', 'Cap Rate (%)'] as const;
    const elements = buildRow('Sheet1', markerHeader, ['Acme Tower', '5.25'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext(), true);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.metric).toBe('cap_rate');
    expect(accepted[0].value).toEqual({ amount: 5.25, unit: 'percent' });
    expect(rejected).toEqual([]);
  });

  it('should resolve a bare fraction via a "(ratio)" header marker with the flag on', () => {
    const markerHeader = ['Property Name', 'Cap Rate (ratio)'] as const;
    const elements = buildRow('Sheet1', markerHeader, ['Acme Tower', '0.0525'], 2);

    const { accepted, rejected } = extractXlsxFacts(elements, extractionContext(), true);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].value).toEqual({ amount: 0.0525, unit: 'ratio' });
    expect(rejected).toEqual([]);
  });
});

describe('extractXlsxFacts — reducedFidelityReasons (header ambiguity)', () => {
  it('should surface a per-sheet reason when the header row repeats a value across its own cells', () => {
    const elements = [
      cellElement('Comps', 'A1', 'Sale'),
      cellElement('Comps', 'B1', 'Sale'),
      cellElement('Comps', 'C1', 'Metrics'),
      cellElement('Comps', 'D1', 'Metrics'),
      cellElement('Comps', 'A2', 'Property Name'),
      cellElement('Comps', 'B2', 'Sale Date'),
      cellElement('Comps', 'C2', 'Building Area (SF)'),
      cellElement('Comps', 'D2', 'Cap Rate'),
      cellElement('Comps', 'A3', 'Acme Tower'),
      cellElement('Comps', 'B3', '2025-01-15'),
      cellElement('Comps', 'C3', '100,000'),
      cellElement('Comps', 'D3', '5.25%'),
    ];

    const { reducedFidelityReasons } = extractXlsxFacts(elements, extractionContext());

    expect(reducedFidelityReasons).toHaveLength(1);
    expect(reducedFidelityReasons[0]).toContain("Sheet 'Comps'");
    expect(reducedFidelityReasons[0]).toContain('repeats a value');
  });

  it('should surface a per-sheet reason when no row in the sheet looks like a header', () => {
    const elements = [
      cellElement('Comps', 'A1', 'note one'),
      cellElement('Comps', 'A2', 'note two'),
      cellElement('Comps', 'A3', 'note three'),
    ];

    const { reducedFidelityReasons } = extractXlsxFacts(elements, extractionContext());

    expect(reducedFidelityReasons).toHaveLength(1);
    expect(reducedFidelityReasons[0]).toContain("Sheet 'Comps'");
    expect(reducedFidelityReasons[0]).toContain('no row within the first');
  });

  it('should be empty for a clean single-row header', async () => {
    const content = await readFile(FIXTURE_PATH);
    const parsed = await new XlsxParser().parse(content);

    const { reducedFidelityReasons } = extractXlsxFacts(parsed.elements, extractionContext());

    expect(reducedFidelityReasons).toEqual([]);
  });
});

describe('extractXlsxFacts — merge-covered cells are not minted as facts', () => {
  // The defect: a merge spanning two metric columns in a data row used to mint one identical-
  // valued fact per column it covered, because the fact-minting loop walked every cell in the row
  // including the propagated merge text. Only B2 (the merge's master) is mergeCovered-free; C2
  // carries the propagated "$500,000" text but must not mint its own price_per_sf fact from it.
  it('should mint only one fact from a merge master, never a second from the cell it covers', () => {
    const elements = [
      cellElement('Sheet1', 'A1', 'Property Name'),
      cellElement('Sheet1', 'B1', 'Sale Price (USD)'),
      cellElement('Sheet1', 'C1', 'Price per SF (USD)'),
      cellElement('Sheet1', 'A2', 'Acme Tower'),
      cellElement('Sheet1', 'B2', '$500,000'),
      cellElement('Sheet1', 'C2', '$500,000', true),
    ];

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.metric).toBe('sale_price');
    expect(accepted.some((fact) => fact.factKey.metric === 'price_per_sf')).toBe(false);
  });

  it('should still use a merge-covered cell for the entity/period/as-of lookups, not only the fact-minting loop', () => {
    // The entity column itself is the merge-covered cell here — the fact-minting skip must not
    // also blind the row-level entity lookup, or the row would drop instead of keying to the
    // (correctly propagated) entity name.
    const elements = [
      cellElement('Sheet1', 'A1', 'Property Name'),
      cellElement('Sheet1', 'B1', 'Building Area (SF)'),
      cellElement('Sheet1', 'A2', 'Acme Tower', true),
      cellElement('Sheet1', 'B2', '100,000'),
    ];

    const { accepted } = extractXlsxFacts(elements, extractionContext());

    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.entity).toBe('Acme Tower');
  });
});

describe('extractXlsxFacts — header-inferred measure proposals', () => {
  const unmatchedHeaderRow = ['Property Name', 'Unit Count'] as const;

  it('should stay inert (byte-for-byte) with proposeFromHeaders off: an unmatched numeric column yields no proposal and no fact', () => {
    const elements = buildRow('Sheet1', unmatchedHeaderRow, ['Acme Tower', '12'], 2);

    const { accepted, proposals } = extractXlsxFacts(elements, extractionContext());

    expect(proposals).toEqual([]);
    expect(accepted).toEqual([]);
  });

  it('should propose an unmatched numeric column with proposeFromHeaders on, one candidate per data row', () => {
    const elements = [
      ...buildRow('Sheet1', unmatchedHeaderRow, ['Acme Tower', '12'], 2),
      cellElement('Sheet1', 'A3', 'Beta Plaza'),
      cellElement('Sheet1', 'B3', '9'),
    ];

    const { accepted, proposals } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(accepted).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposal.slug).toBe('unit_count');
    expect(proposals[0].proposal.valueType).toBe('count');
    expect(proposals[0].candidates).toHaveLength(2);
    expect(
      proposals[0].candidates.every((candidate) => candidate.factKey.metric === 'unit_count'),
    ).toBe(true);
  });

  it('should propose nothing for a slug already rejected as a measure, even with proposeFromHeaders on', () => {
    const elements = buildRow('Sheet1', unmatchedHeaderRow, ['Acme Tower', '12'], 2);

    const { accepted, proposals } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true, new Set(['unit_count'])),
    );

    expect(proposals).toEqual([]);
    expect(accepted).toEqual([]);
  });

  it('should match a header whose derived slug names a confirmed measure instead of proposing it', () => {
    // 'Cap-Rate' aliases nothing in METRIC_ONTOLOGY, but derives the same slug ('cap_rate') as the
    // seeded metric of that id — the slug fallback in the header→definition resolution order.
    const slugHeaderRow = ['Property Name', 'Cap-Rate'] as const;
    const elements = buildRow('Sheet1', slugHeaderRow, ['Acme Tower', '5.25%'], 2);

    const { accepted, proposals } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(proposals).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].factKey.metric).toBe('cap_rate');
    expect(accepted[0].value).toEqual({ amount: 5.25, unit: 'percent' });
  });

  it('should refuse a mixed column even with proposeFromHeaders on — a stray label mints nothing', () => {
    const elements = [
      ...buildRow('Sheet1', unmatchedHeaderRow, ['Acme Tower', '12'], 2),
      cellElement('Sheet1', 'A3', 'Beta Plaza'),
      cellElement('Sheet1', 'B3', 'n/a'),
    ];

    const { accepted, proposals } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(proposals).toEqual([]);
    expect(accepted).toEqual([]);
  });

  // One metric per `area | duration | count` valueType, so `parseBaseUnitDisplay` is swept for
  // every branch `parseDisplayValue` now routes through it, not only the area case that existed
  // before it was generalized.
  const BASE_UNIT_ONTOLOGY: readonly MetricDefinition[] = [
    {
      id: 'lot_size',
      label: 'Lot Size',
      aliases: ['Lot Size'],
      valueType: 'area',
      canonicalUnit: 'sf',
      units: [{ id: 'sf', toCanonicalFactor: 1 }],
      toleranceKind: 'relative',
      tolerance: 0.01,
    },
    {
      id: 'lease_term',
      label: 'Lease Term',
      aliases: ['Lease Term'],
      valueType: 'duration',
      canonicalUnit: 'years',
      units: [{ id: 'years', toCanonicalFactor: 1 }],
      toleranceKind: 'absolute',
      tolerance: 0,
    },
    {
      id: 'unit_count_metric',
      label: 'Unit Count Metric',
      aliases: ['Unit Count Metric'],
      valueType: 'count',
      canonicalUnit: 'count',
      units: [{ id: 'count', toCanonicalFactor: 1 }],
      toleranceKind: 'absolute',
      tolerance: 0,
    },
  ];

  // The cap is a property of the whole document, not of a sheet, so this builds one sheet per
  // proposal: if it were enforced per sheet instead, every one of these columns would pass. It is
  // parameterized on the constant so the bound can be retuned without rewriting the test, and it
  // asserts the excess column contributes no facts by either route — neither `accepted` nor a
  // proposal's own `candidates`.
  it('should cap distinct header proposals per document, across sheets, and say so', () => {
    const overCap = MAX_HEADER_PROPOSALS_PER_DOCUMENT + 1;
    const elements = Array.from({ length: overCap }, (_unused, index) =>
      buildRow(
        `Sheet${index}`,
        ['Property Name', `Bespoke Measure ${index}`],
        ['Acme Tower', '1234'],
        2,
      ),
    ).flat();

    const { accepted, proposals, reducedFidelityReasons } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(proposals).toHaveLength(MAX_HEADER_PROPOSALS_PER_DOCUMENT);
    expect(new Set(proposals.map((entry) => entry.proposal.slug)).size).toBe(
      MAX_HEADER_PROPOSALS_PER_DOCUMENT,
    );
    // Fails closed: the one column past the cap mints nothing down either route.
    const mintedSlugs = new Set([
      ...accepted.map((candidate) => candidate.factKey.metric),
      ...proposals.flatMap((entry) =>
        entry.candidates.map((candidate) => candidate.factKey.metric),
      ),
    ]);
    expect(mintedSlugs.has(`bespoke_measure_${MAX_HEADER_PROPOSALS_PER_DOCUMENT}`)).toBe(false);
    expect(reducedFidelityReasons).toContainEqual(
      expect.stringContaining(
        `Header measure proposals capped at ${MAX_HEADER_PROPOSALS_PER_DOCUMENT} per document`,
      ),
    );
  });

  it('should propose every column of a document sitting exactly at the cap', () => {
    const elements = Array.from({ length: MAX_HEADER_PROPOSALS_PER_DOCUMENT }, (_unused, index) =>
      buildRow(
        `Sheet${index}`,
        ['Property Name', `Bespoke Measure ${index}`],
        ['Acme Tower', '1234'],
        2,
      ),
    ).flat();

    const { proposals, reducedFidelityReasons } = extractXlsxFacts(
      elements,
      extractionContext(METRIC_ONTOLOGY, true),
    );

    expect(proposals).toHaveLength(MAX_HEADER_PROPOSALS_PER_DOCUMENT);
    expect(reducedFidelityReasons).toEqual([]);
  });

  it.each(BASE_UNIT_ONTOLOGY)(
    'should mint a bare "1,234" cell in the factor-1 unit for a $valueType metric',
    (metric) => {
      const elements = buildRow(
        'Sheet1',
        ['Property Name', metric.label],
        ['Acme Tower', '1,234'],
        2,
      );

      const { accepted, rejected } = extractXlsxFacts(
        elements,
        extractionContext(BASE_UNIT_ONTOLOGY),
      );

      expect(rejected).toEqual([]);
      expect(accepted[0].value).toEqual({ amount: 1234, unit: metric.units[0].id });
    },
  );
});

// The cell every sweep row plants its candidate text in: third column, first data row.
const CANDIDATE_CELL = 'C2';

/**
 * Every class of numeric-literal text this extractor's grammar refuses, enumerated by class rather
 * than by reported instance. `Number()` turns each of these into a value the cell never displayed —
 * `Infinity`, `16`, `0`, `5` — and a fact minted from one is a figure no document states.
 */
const REFUSED_NUMERIC_TEXT: readonly string[] = [
  // Non-finite words `Number()` reads as literal IEEE values.
  'Infinity',
  '-Infinity',
  '+Infinity',
  'infinity',
  'INFINITY',
  'Infinity%',
  '-Infinity%',
  'NaN',
  'nan',
  // Exponent notation: overflows to Infinity from 1e309 up, underflows to 0 below 1e-323, and is
  // not a form a spreadsheet displays a real quantity in between those either.
  '1e400',
  '-1e400',
  '1E400',
  '1e309',
  '1e5',
  '1.5e3',
  '1e-400',
  // Alternate radix and separator prefixes `Number()` accepts and a reader does not.
  '0x10',
  '0X1F',
  '0b101',
  '0o17',
  '1_000',
  // Empty or separator-only text: `Number('')` is 0, so a cell holding only punctuation would mint
  // a zero-valued fact.
  ',',
  ',,',
  '%',
  '$',
  '$,',
  '-',
  '+',
  '.',
  '-.',
  '--5',
  '$%',
  // Digit scripts outside ASCII 0-9 — Arabic-Indic, full-width, Devanagari: legible as a number to
  // a reader, unparseable here, and never silently readable as some other number.
  '٥٢٥',
  '５２５',
  '१२३',
  // Leading and trailing sign forms.
  '5-',
  '5+',
  '+5',
  '- 5',
  '5 -',
  // Whitespace inside the digit run, including a non-breaking space.
  '1 000',
  '1 000',
  // Finite but no longer faithful: past MAX_SAFE_INTEGER two source figures a few units apart
  // collapse onto the same double, and a long enough run overflows outright.
  '9007199254740993',
  '12345678901234567890',
  '9'.repeat(320),
];

interface SweepColumn {
  readonly header: string;
  readonly metricId: string;
  /** Two cells in the same `(entity, metric, period)` group that genuinely disagree past the
   *  metric's tolerance, expressed in the display forms that column actually carries. */
  readonly lower: string;
  readonly higher: string;
  readonly magnitude: number;
}

// One column per `valueType` branch of `parseDisplayValue`, so every display parser in the file is
// swept, not only the area parser the reproduction used.
const SWEEP_COLUMNS: readonly SweepColumn[] = [
  {
    header: 'Building Area (SF)',
    metricId: 'building_area_sf',
    lower: '100000',
    higher: '120000',
    magnitude: 20_000,
  },
  {
    header: 'Sale Price (USD)',
    metricId: 'sale_price',
    lower: '$100,000',
    higher: '$120,000',
    magnitude: 20_000,
  },
  { header: 'Cap Rate', metricId: 'cap_rate', lower: '5.25%', higher: '6.10%', magnitude: 0.0085 },
];

function csvField(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Drives the value column through the real `CsvParser` (a two-plus-line `text/csv` upload) into
 *  the real extractor — the same path a user's spreadsheet upload takes, rather than hand-built
 *  `ParsedElement`s that could disagree with what a parser actually emits. */
async function extractFromCsv(
  header: string,
  valueColumn: readonly string[],
): Promise<ReturnType<typeof extractXlsxFacts>> {
  const rows = [
    ['Property Name', 'Sale Date', header],
    ...valueColumn.map((text) => ['Northgate Business Park', '2025-03-14', text]),
  ];
  const csv = Buffer.from(rows.map((row) => row.map(csvField).join(',')).join('\n'), 'utf8');
  const parsed = await new CsvParser(',', ['text/csv']).parse(csv);
  return extractXlsxFacts(parsed.elements, extractionContext());
}

function asScannableFacts(
  accepted: ReturnType<typeof extractXlsxFacts>['accepted'],
): FactForConflictScan[] {
  return accepted.map((fact, index) => ({
    id: `fact-${index}`,
    factKey: fact.factKey,
    value: fact.value,
  }));
}

function candidateLabel(text: string): string {
  return text.length > 24
    ? `${JSON.stringify(text.slice(0, 20))} (${text.length} chars)`
    : JSON.stringify(text);
}

describe('extractXlsxFacts — numeric grammar sweep, extractor through detector', () => {
  for (const column of SWEEP_COLUMNS) {
    describe(`${column.header} (${column.metricId})`, () => {
      it('should mint the decimal forms the grammar accepts and detect their disagreement', async () => {
        const { accepted, rejected } = await extractFromCsv(column.header, [
          column.lower,
          column.higher,
        ]);

        expect(accepted).toHaveLength(2);
        expect(rejected).toEqual([]);

        const { conflicts, skipped } = detectConflicts(asScannableFacts(accepted), METRIC_ONTOLOGY);

        expect(skipped).toEqual([]);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].magnitude).toBeCloseTo(column.magnitude, 10);
      });

      for (const candidate of REFUSED_NUMERIC_TEXT) {
        it(`should refuse ${candidateLabel(candidate)} visibly and still detect the real disagreement in its group`, async () => {
          const { accepted, rejected, reducedFidelityReasons } = await extractFromCsv(
            column.header,
            [candidate, column.lower, column.higher],
          );

          // (a) No fact is minted from the candidate cell, and no amount anywhere in the result is
          // a value a double cannot faithfully hold.
          expect(accepted.map((fact) => (fact.locator as XlsxCellLocator).cell)).not.toContain(
            CANDIDATE_CELL,
          );
          expect(
            accepted.filter(
              (fact) =>
                !Number.isFinite(fact.value.amount) ||
                Math.abs(fact.value.amount) > Number.MAX_SAFE_INTEGER,
            ),
          ).toEqual([]);

          // (b) The refusal is visible: a rejected candidate for that cell, surfaced on the
          // operator-facing reasons the caller persists.
          expect(rejected.map((entry) => (entry.locator as XlsxCellLocator).cell)).toContain(
            CANDIDATE_CELL,
          );
          expect(reducedFidelityReasons.join(' ')).toContain('produced no fact');

          // (c) The genuine disagreement sharing the candidate's group is still detected — one
          // poisoned cell must not make a real conflict invisible.
          const { conflicts, skipped } = detectConflicts(
            asScannableFacts(accepted),
            METRIC_ONTOLOGY,
          );

          expect(skipped).toEqual([]);
          expect(conflicts).toHaveLength(1);
          expect(conflicts[0].magnitude).toBeCloseTo(column.magnitude, 10);
        });
      }

      // The CSV parser drops a cell whose text trims to empty, so this class only reaches the
      // extractor from a workbook — where a whitespace-only cell is exactly what an emptied-out
      // formula leaves behind.
      it('should refuse a whitespace-only cell visibly', () => {
        const elements = [
          cellElement('Sheet1', 'A1', 'Property Name'),
          cellElement('Sheet1', 'B1', 'Sale Date'),
          cellElement('Sheet1', 'C1', column.header),
          cellElement('Sheet1', 'A2', 'Northgate Business Park'),
          cellElement('Sheet1', 'B2', '2025-03-14'),
          cellElement('Sheet1', 'C2', '   '),
        ];

        const { accepted, rejected } = extractXlsxFacts(elements, extractionContext());

        expect(accepted).toEqual([]);
        expect(rejected.map((entry) => (entry.locator as XlsxCellLocator).cell)).toContain(
          CANDIDATE_CELL,
        );
      });
    });
  }
});
