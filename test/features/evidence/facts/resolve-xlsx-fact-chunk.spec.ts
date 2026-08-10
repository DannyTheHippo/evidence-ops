import {
  findXlsxRegionChunk,
  parseRowFromCellAddress,
} from '../../../../src/features/evidence/facts/resolve-xlsx-fact-chunk';

interface FakeChunk {
  readonly id: string;
  readonly locator: unknown;
}

function regionChunk(id: string, sheetName: string, range: string): FakeChunk {
  return { id, locator: { kind: 'xlsx-region', sheetName, range, extractorVersion: 'v1' } };
}

describe('findXlsxRegionChunk', () => {
  const chunks = [
    regionChunk('chunk-1', 'Comps', 'A1:H6'),
    regionChunk('chunk-2', 'Comps', 'A1:H11'),
  ];

  it('should find the chunk whose row range contains the cell row', () => {
    const found = findXlsxRegionChunk([regionChunk('only', 'Comps', 'A1:H11')], 'Comps', 2);

    expect(found?.id).toBe('only');
  });

  it('should return the first matching chunk when ranges overlap', () => {
    const found = findXlsxRegionChunk(chunks, 'Comps', 3);

    expect(found?.id).toBe('chunk-1');
  });

  it('should return undefined when no chunk covers the row', () => {
    const found = findXlsxRegionChunk([regionChunk('only', 'Comps', 'A1:H6')], 'Comps', 9);

    expect(found).toBeUndefined();
  });

  it('should return undefined when the sheet name does not match', () => {
    const found = findXlsxRegionChunk([regionChunk('only', 'OtherSheet', 'A1:H11')], 'Comps', 2);

    expect(found).toBeUndefined();
  });

  it('should ignore a non-xlsx-region chunk', () => {
    const chunk: FakeChunk = {
      id: 'prose',
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
    };

    expect(findXlsxRegionChunk([chunk], 'Comps', 2)).toBeUndefined();
  });

  it('should return undefined for an empty chunk list', () => {
    expect(findXlsxRegionChunk([], 'Comps', 2)).toBeUndefined();
  });
});

describe('parseRowFromCellAddress', () => {
  it('should parse the row number from an A1-notation address', () => {
    expect(parseRowFromCellAddress('F2')).toBe(2);
    expect(parseRowFromCellAddress('AB123')).toBe(123);
  });

  it('should throw for an address with no row digits', () => {
    expect(() => parseRowFromCellAddress('F')).toThrow('is not in A1 notation');
  });
});
