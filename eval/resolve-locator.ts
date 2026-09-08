import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedElement } from '../src/features/evidence/ingestion/parsers/parsed-element.type';
import { parserForFile } from './parser-for-file';
import type { Locator } from './dataset/schema';

export const DATA_ROOM_DIR = path.join(__dirname, '../fixtures/data-room');

/**
 * Resolves a dataset locator to the text that actually sits there, by parsing the source document
 * with the same parsers the ingestion pipeline uses.
 *
 * This exists because checking a locator against `manifest.json` only proves the dataset agrees
 * with the generator — and when the generator was wrong (a stray blank page after every content
 * page) both agreed, both were wrong, and every test stayed green. The only authority on what a
 * document contains is the document.
 *
 * Parsing is cached per `${corpusDir}:${file}`: a 32-case dataset otherwise re-parses the same four
 * fixtures dozens of times, and the corpus dir is part of the key because the same filename can
 * exist under more than one lane's corpus (each lane's own tenant).
 */
const cache = new Map<string, Promise<readonly ParsedElement[]>>();

function parseFixture(corpusDir: string, file: string): Promise<readonly ParsedElement[]> {
  const cacheKey = `${corpusDir}:${file}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<readonly ParsedElement[]> => {
    const content = await readFile(path.join(corpusDir, file));
    const parser = parserForFile(file);

    return (await parser.parse(content)).elements;
  })();

  cache.set(cacheKey, pending);
  return pending;
}

const columnToIndex = (letters: string): number =>
  letters
    .split('')
    .reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1), 0);

function parseAddress(address: string): { column: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) {
    throw new Error(`not an A1-style cell address: ${address}`);
  }
  return { column: columnToIndex(match[1]), row: Number(match[2]) };
}

/**
 * True when `cell` falls inside `spec`, which may itself be a single cell or an A1 range.
 * Exported for `eval/metrics/locator-overlap.ts`, which reuses this exact address math to test a
 * dataset `xlsx-cell` locator against a retrieved chunk's `xlsx-region` range — a chunk's
 * spreadsheet locator is a range, not a cell, so containment (not equality) is the right test.
 */
export function addressMatches(spec: string, cell: string): boolean {
  const [startText, endText] = spec.split(':');
  const target = parseAddress(cell);
  const start = parseAddress(startText);
  const end = parseAddress(endText ?? startText);

  return (
    target.row >= Math.min(start.row, end.row) &&
    target.row <= Math.max(start.row, end.row) &&
    target.column >= Math.min(start.column, end.column) &&
    target.column <= Math.max(start.column, end.column)
  );
}

/**
 * Every parsed element the locator covers. A range locator legitimately covers many elements; a
 * locator covering none is a broken case, and callers should treat an empty result as a failure
 * rather than as "no match". `corpusDir` defaults to the synthetic lane's fixtures — the benchmark
 * and public lanes pass their own (`LaneConfig.corpusDir`, `eval/lanes.ts`).
 */
export async function resolveLocatorElements(
  locator: Locator,
  corpusDir: string = DATA_ROOM_DIR,
): Promise<readonly ParsedElement[]> {
  const elements = await parseFixture(corpusDir, locator.file);

  switch (locator.kind) {
    case 'pdf-page':
      return elements.filter(
        (element) => element.locator.kind === 'pdf-page' && element.locator.page === locator.page,
      );
    case 'docx-paragraph':
      return elements.filter(
        (element) =>
          element.locator.kind === 'docx-paragraph' &&
          element.locator.paragraphIndex === locator.paragraphIndex,
      );
    case 'xlsx-cell':
      return elements.filter(
        (element) =>
          element.locator.kind === 'xlsx-cell' &&
          element.locator.sheetName === locator.sheet &&
          addressMatches(locator.cell, element.locator.cell),
      );
    case 'text-block':
      return elements.filter(
        (element) =>
          element.locator.kind === 'text-block' &&
          element.locator.blockIndex === locator.blockIndex,
      );
  }
}

/** The concatenated text a locator points at, for substring assertions. */
export async function resolveLocatorText(
  locator: Locator,
  corpusDir: string = DATA_ROOM_DIR,
): Promise<string> {
  const elements = await resolveLocatorElements(locator, corpusDir);
  return elements.map((element) => element.text).join('\n');
}
