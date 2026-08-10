import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DocxParser } from '../src/features/evidence/ingestion/parsers/docx.parser';
import type { ParsedElement } from '../src/features/evidence/ingestion/parsers/parsed-element.type';
import { PdfParser } from '../src/features/evidence/ingestion/parsers/pdf.parser';
import { XlsxParser } from '../src/features/evidence/ingestion/parsers/xlsx.parser';
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
 * Parsing is cached per file: a 32-case dataset otherwise re-parses the same four fixtures dozens
 * of times.
 */
const cache = new Map<string, Promise<readonly ParsedElement[]>>();

function parseFixture(file: string): Promise<readonly ParsedElement[]> {
  const cached = cache.get(file);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<readonly ParsedElement[]> => {
    const content = await readFile(path.join(DATA_ROOM_DIR, file));
    const parser = file.endsWith('.pdf')
      ? new PdfParser()
      : file.endsWith('.docx')
        ? new DocxParser()
        : new XlsxParser();

    return (await parser.parse(content)).elements;
  })();

  cache.set(file, pending);
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

/** True when `cell` falls inside `spec`, which may itself be a single cell or an A1 range. */
function addressMatches(spec: string, cell: string): boolean {
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
 * rather than as "no match".
 */
export async function resolveLocatorElements(locator: Locator): Promise<readonly ParsedElement[]> {
  const elements = await parseFixture(locator.file);

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
  }
}

/** The concatenated text a locator points at, for substring assertions. */
export async function resolveLocatorText(locator: Locator): Promise<string> {
  const elements = await resolveLocatorElements(locator);
  return elements.map((element) => element.text).join('\n');
}
