import cases from '../../eval/dataset/cases.json';
import { EvalDatasetSchema, type Locator } from '../../eval/dataset/schema';
import { resolveLocatorText } from '../../eval/resolve-locator';
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

// One comparable key per seeded-conflict location and per dataset locator, so an answerable case
// pointing at a location the corpus seeds as conflicting is a string match rather than shape math.
// Exact cell/page identity is the whole test — a locator one cell or one page away from a seeded
// conflict is a different fact and stays legal.
const conflictLocationKeys = new Set(
  manifest.conflicts.flatMap((conflict) =>
    conflict.locations.map((location) =>
      'cell' in location
        ? `${location.file}!${location.sheet}!${location.cell}`
        : `${location.file}#${location.page}`,
    ),
  ),
);

const locatorKey = (locator: Locator): string => {
  switch (locator.kind) {
    case 'xlsx-cell':
      return `${locator.file}!${locator.sheet}!${locator.cell}`;
    case 'pdf-page':
      return `${locator.file}#${locator.page}`;
    case 'docx-paragraph':
      return `${locator.file}¶${locator.paragraphIndex}`;
  }
};

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

  // An answerable case whose ground truth is a seeded-conflict location contradicts the conflicting
  // case built on that same location: the pipeline can only satisfy one of them, so the dataset
  // fails structurally in every run no matter how the system behaves. Conflicting cases are exempt —
  // pointing at those locations is exactly what they are for.
  it('should keep every answerable case off the seeded-conflict locations', () => {
    const offending = EvalDatasetSchema.parse(cases)
      .filter((evalCase) => evalCase.category === 'answerable')
      .flatMap((evalCase) =>
        evalCase.expectedLocators
          .map(locatorKey)
          .filter((key) => conflictLocationKeys.has(key))
          .map((key) => `${evalCase.id} -> ${key}`),
      );

    expect(offending).toEqual([]);
  });

  it('should resolve every expected locator against fixtures/data-room/manifest.json', () => {
    const parsed = EvalDatasetSchema.parse(cases);
    for (const evalCase of parsed) {
      for (const locator of evalCase.expectedLocators) {
        assertLocatorExistsInManifest(locator, manifest);
      }
    }
  });

  // The check above only proves the dataset agrees with the generated manifest. When the fixture
  // generator was emitting a stray blank page after every content page, the manifest recorded the
  // page numbers it *intended* and the dataset matched them perfectly — while every PDF locator
  // pointed one page off, at blank paper. Both artifacts agreed and both were wrong.
  //
  // These two assertions go to the documents themselves, via the same parsers ingestion uses.
  describe('expected locators hold the expected answer (parsed from the documents)', () => {
    jest.setTimeout(60_000);

    const grounded = EvalDatasetSchema.parse(cases).filter(
      (evalCase) => (evalCase.expectedAnswerContains ?? []).length > 0,
    );

    it('covers every answerable and conflicting case', () => {
      const requiring = EvalDatasetSchema.parse(cases).filter(
        (evalCase) => evalCase.category === 'answerable' || evalCase.category === 'conflicting',
      );

      expect(grounded.map((c) => c.id).sort()).toEqual(requiring.map((c) => c.id).sort());
    });

    it.each(grounded.map((evalCase) => [evalCase.id, evalCase] as const))(
      '%s',
      async (_id, evalCase) => {
        const texts = await Promise.all(
          evalCase.expectedLocators.map((locator) => resolveLocatorText(locator)),
        );

        // An empty resolution means the locator points at nothing at all — a broken case, not a
        // near miss, so it is worth failing distinctly from a missing substring.
        texts.forEach((text, index) => {
          expect({ locator: evalCase.expectedLocators[index], empty: text.trim() === '' }).toEqual({
            locator: evalCase.expectedLocators[index],
            empty: false,
          });
        });

        const combined = texts.join('\n');
        for (const needle of evalCase.expectedAnswerContains ?? []) {
          expect(combined).toContain(needle);
        }
      },
    );
  });
});
