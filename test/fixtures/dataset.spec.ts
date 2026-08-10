import cases from '../../eval/dataset/cases.json';
import { EvalDatasetSchema, type Locator } from '../../eval/dataset/schema';
import manifest from '../../fixtures/data-room/manifest.json';

type Manifest = typeof manifest;

// Parses an A1-style column letter run ("A", "AB", ...) into a 1-based column index.
const columnLetterToIndex = (letters: string): number =>
  letters
    .split('')
    .reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1), 0);

const parseCellAddress = (address: string): { column: number; row: number } => {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) {
    throw new Error(`not an A1-style cell address: ${address}`);
  }
  const [, letters, rowText] = match;
  return { column: columnLetterToIndex(letters), row: Number(rowText) };
};

const parseUsedRange = (
  usedRange: string,
): { minColumn: number; maxColumn: number; minRow: number; maxRow: number } => {
  const [start, end] = usedRange.split(':');
  const startCell = parseCellAddress(start);
  const endCell = parseCellAddress(end);
  return {
    minColumn: startCell.column,
    maxColumn: endCell.column,
    minRow: startCell.row,
    maxRow: endCell.row,
  };
};

// Cross-references one locator against manifest.json — this is what stops a dataset case from
// pointing at a page, cell, or paragraph the corpus does not actually contain.
function assertLocatorExistsInManifest(locator: Locator, manifestData: Manifest): void {
  const file = manifestData.files[locator.file as keyof Manifest['files']];
  if (!file) {
    throw new Error(`manifest.json has no entry for file "${locator.file}"`);
  }

  switch (locator.kind) {
    case 'pdf-page': {
      if (!('pageCount' in file)) {
        throw new Error(`"${locator.file}" has no pageCount in manifest.json`);
      }
      expect(locator.page).toBeGreaterThanOrEqual(1);
      expect(locator.page).toBeLessThanOrEqual(file.pageCount);
      return;
    }
    case 'xlsx-cell': {
      if (!('sheets' in file)) {
        throw new Error(`"${locator.file}" has no sheets in manifest.json`);
      }
      const sheet = file.sheets.find((candidate) => candidate.name === locator.sheet);
      if (!sheet) {
        throw new Error(`"${locator.file}" has no sheet named "${locator.sheet}"`);
      }
      const bounds = parseUsedRange(sheet.usedRange);
      const [startAddress, endAddress] = locator.cell.split(':');
      const cellsToCheck = [startAddress, endAddress ?? startAddress].map(parseCellAddress);
      for (const cell of cellsToCheck) {
        expect(cell.column).toBeGreaterThanOrEqual(bounds.minColumn);
        expect(cell.column).toBeLessThanOrEqual(bounds.maxColumn);
        expect(cell.row).toBeGreaterThanOrEqual(bounds.minRow);
        expect(cell.row).toBeLessThanOrEqual(bounds.maxRow);
      }
      return;
    }
    case 'docx-paragraph': {
      if (!('paragraphs' in file)) {
        throw new Error(`"${locator.file}" has no paragraphs in manifest.json`);
      }
      const paragraph = file.paragraphs.find(
        (candidate) => candidate.index === locator.paragraphIndex,
      );
      if (!paragraph) {
        throw new Error(`"${locator.file}" has no paragraph at index ${locator.paragraphIndex}`);
      }
      expect(paragraph.headingPath).toEqual(locator.headingPath);
      return;
    }
  }
}

describe('eval dataset', () => {
  it('should validate every case against EvalCaseSchema', () => {
    const result = EvalDatasetSchema.safeParse(cases);
    if (!result.success) {
      throw new Error(`dataset validation failed: ${result.error.toString()}`);
    }
  });

  it('should have unique case ids', () => {
    const ids = cases.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have at least one case in every category', () => {
    const categories = new Set(cases.map((evalCase) => evalCase.category));
    expect(categories).toEqual(
      new Set(['answerable', 'unanswerable', 'conflicting', 'adversarial']),
    );
  });

  it('should resolve every expected locator against fixtures/data-room/manifest.json', () => {
    const parsed = EvalDatasetSchema.parse(cases);
    for (const evalCase of parsed) {
      for (const locator of evalCase.expectedLocators) {
        assertLocatorExistsInManifest(locator, manifest);
      }
    }
  });
});
