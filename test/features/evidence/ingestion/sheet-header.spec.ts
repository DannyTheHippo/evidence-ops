import {
  detectHeaderRow,
  parseHeaderUnitMarker,
  resolveHeaderRow,
  type HeaderDetectionCell,
} from '../../../../src/features/evidence/ingestion/sheet-header';

function cell(row: number, text: string): HeaderDetectionCell {
  return { row, text };
}

describe('detectHeaderRow', () => {
  it('should pick the topmost occupied row as the header when it has enough distinct values', () => {
    const cells = [
      cell(1, 'Property Name'),
      cell(1, 'Sale Date'),
      cell(2, 'Acme Tower'),
      cell(2, '2025-01-15'),
    ];

    expect(detectHeaderRow(cells)).toBe(1);
  });

  // The defect this exists to fix: a report-layout sheet with a title above the real header row
  // must not treat row 1 as the header.
  it('should skip a title row and find the real header below it', () => {
    const cells = [
      cell(1, 'Q1 2025 Comparable Sales Report'),
      cell(3, 'Property Name'),
      cell(3, 'Sale Date'),
      cell(4, 'Acme Tower'),
      cell(4, '2025-01-15'),
    ];

    expect(detectHeaderRow(cells)).toBe(3);
  });

  // The distinct-values rule composing with xlsx.parser.ts's merged-cell propagation: a merged
  // title spans many cells but only one distinct value, so it is never mistaken for a header even
  // though it clears the "at least 2 non-empty cells" bar on its own.
  it('should reject a row with several non-empty cells that all repeat the same propagated value', () => {
    const cells = [
      cell(1, 'Q1 2025 Comparable Sales Report'),
      cell(1, 'Q1 2025 Comparable Sales Report'),
      cell(1, 'Q1 2025 Comparable Sales Report'),
      cell(2, 'Property Name'),
      cell(2, 'Sale Date'),
      cell(3, 'Acme Tower'),
      cell(3, '2025-01-15'),
    ];

    expect(detectHeaderRow(cells)).toBe(2);
  });

  it('should bound the scan to the first 10 occupied rows and fall back to the topmost one beyond that', () => {
    // Rows 1-10 are single-cell "occupied" rows (a tall preamble); the real header sits at
    // occupied row 11, one past the scan bound, so it is never reached.
    const preambleCells = Array.from({ length: 10 }, (_, index) => cell(index + 1, 'note'));
    const cells = [
      ...preambleCells,
      cell(11, 'Property Name'),
      cell(11, 'Sale Date'),
      cell(12, 'Acme Tower'),
      cell(12, '2025-01-15'),
    ];

    expect(detectHeaderRow(cells)).toBe(1);
  });

  it('should fall back to the topmost occupied row when no scanned row qualifies as a header', () => {
    // Every occupied row here has only one non-empty cell — none ever clears the "at least 2
    // non-empty cells" bar, so nothing in the scanned window can qualify.
    const cells = [cell(1, 'note one'), cell(2, 'note two'), cell(3, 'note three')];

    expect(detectHeaderRow(cells)).toBe(1);
  });

  it('should fall back to the topmost occupied row when the only candidate has nothing below it', () => {
    // Two distinct non-empty cells, but it is the last occupied row in the sheet — no row after it
    // to be data, so it cannot be the header.
    const cells = [cell(1, 'Property Name'), cell(1, 'Sale Date')];

    expect(detectHeaderRow(cells)).toBe(1);
  });

  it('should return row 1 for an empty cell list without throwing', () => {
    expect(detectHeaderRow([])).toBe(1);
  });

  it('should not count blank-text cells toward the two-non-empty-cells bar', () => {
    // Both parsers feeding this skip empty cells today, so this pins the rule rather than current
    // behaviour: row 1 has two cells but only one carries text, so it must not qualify as the
    // header on a technicality. Row 2 is the first row with two genuinely non-empty values.
    const cells = [
      cell(1, 'Quarterly Summary'),
      cell(1, '   '),
      cell(2, 'Property Name'),
      cell(2, 'Sale Date'),
      cell(3, 'Acme Tower'),
      cell(3, '2025-01-15'),
    ];

    expect(detectHeaderRow(cells)).toBe(2);
  });
});

describe('resolveHeaderRow', () => {
  it('should return no reducedFidelityReason for a clean single-row header', () => {
    const cells = [
      cell(1, 'Property Name'),
      cell(1, 'Sale Date'),
      cell(2, 'Acme Tower'),
      cell(2, '2025-01-15'),
    ];

    expect(resolveHeaderRow(cells)).toEqual({ headerRow: 1 });
  });

  it('should return no reducedFidelityReason for an empty cell list', () => {
    expect(resolveHeaderRow([])).toEqual({ headerRow: 1 });
  });

  // The two-row-header shape: a grouping row ("Sale", "Sale", "Metrics", "Metrics") repeats a
  // value across its own cells even though it clears the 2-distinct-values bar — the real column
  // labels sit one row below it and would otherwise be read as data.
  it('should flag a reduced-fidelity reason when the chosen header row repeats a value across its own cells', () => {
    const cells = [
      cell(1, 'Sale'),
      cell(1, 'Sale'),
      cell(1, 'Metrics'),
      cell(1, 'Metrics'),
      cell(2, 'Property Name'),
      cell(2, 'Sale Date'),
      cell(2, 'Price'),
      cell(2, 'Cap Rate'),
      cell(3, 'Acme Tower'),
      cell(3, '2025-01-15'),
      cell(3, '$1,000'),
      cell(3, '5%'),
    ];

    const result = resolveHeaderRow(cells);

    expect(result.headerRow).toBe(1);
    expect(result.reducedFidelityReason).toContain('row 1');
    expect(result.reducedFidelityReason).toContain('repeats a value');
  });

  // The header-less shape: no scanned row ever clears the 2-distinct-values-with-a-row-after bar,
  // so the fallback to the topmost occupied row fires — this is the same fallback `detectHeaderRow`
  // has always had, now named rather than silent.
  it('should flag a reduced-fidelity reason when no scanned row qualifies as a header', () => {
    const cells = [cell(1, 'note one'), cell(2, 'note two'), cell(3, 'note three')];

    const result = resolveHeaderRow(cells);

    expect(result.headerRow).toBe(1);
    expect(result.reducedFidelityReason).toContain('no row within the first');
  });
});

describe('parseHeaderUnitMarker', () => {
  it('should return the header unchanged with no unit when there is no trailing marker', () => {
    expect(parseHeaderUnitMarker('Cap Rate')).toEqual({ baseText: 'Cap Rate', unit: undefined });
  });

  it('should split a "(%)" marker off the header and report it as percent', () => {
    expect(parseHeaderUnitMarker('Cap Rate (%)')).toEqual({
      baseText: 'Cap Rate',
      unit: 'percent',
    });
  });

  it('should split a "(ratio)" marker off the header and report it as ratio', () => {
    expect(parseHeaderUnitMarker('Cap Rate (ratio)')).toEqual({
      baseText: 'Cap Rate',
      unit: 'ratio',
    });
  });

  it('should split a "(percent)" marker off the header and report it as percent', () => {
    expect(parseHeaderUnitMarker('Cap Rate (percent)')).toEqual({
      baseText: 'Cap Rate',
      unit: 'percent',
    });
  });

  it('should match the marker case-insensitively', () => {
    expect(parseHeaderUnitMarker('Cap Rate (RATIO)')).toEqual({
      baseText: 'Cap Rate',
      unit: 'ratio',
    });
  });
});
