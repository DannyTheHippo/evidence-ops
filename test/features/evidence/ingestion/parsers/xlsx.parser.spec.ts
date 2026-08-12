import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { XlsxCellLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { sanitizeEvidenceText } from '../../../../../src/features/evidence/ingestion/sanitize-evidence-text';
import {
  MalformedXlsxException,
  XlsxParser,
} from '../../../../../src/features/evidence/ingestion/parsers/xlsx.parser';
import { HostileArchiveException } from '../../../../../src/features/evidence/ingestion/parsers/safe-zip';
import rawManifest from '../../../../../fixtures/data-room/manifest.json';

const FIXTURE_PATH = path.join(__dirname, '../../../../../fixtures/data-room/comps.xlsx');

/**
 * The manifest's `conflict.locations` and `canaries` are heterogeneous — a spreadsheet entry
 * carries sheet/cell, a PDF entry carries a page — and TypeScript's structural inference over an
 * imported JSON literal turns that into optional properties on a merged shape, which no amount of
 * narrowing recovers cleanly. Declaring the contract once and asserting it at the import boundary
 * is honest about what this file assumes; `manifest.spec.ts` is what proves the file matches.
 */
interface XlsxCellAddress {
  readonly sheet: string;
  readonly cell: string;
}

interface DataRoomManifest {
  readonly conflict: {
    readonly locations: readonly ({ readonly file: string } & Partial<XlsxCellAddress> & {
        readonly value?: number;
        readonly display?: string;
      })[];
  };
  readonly canaries: readonly {
    readonly file: string;
    readonly token: string;
    readonly location: Partial<XlsxCellAddress> & { readonly page?: number };
  }[];
}

const manifest = rawManifest as DataRoomManifest;

const isXlsxConflict = (
  location: DataRoomManifest['conflict']['locations'][number],
): location is typeof location & XlsxCellAddress & { display: string; value: number } =>
  location.sheet !== undefined &&
  location.cell !== undefined &&
  location.display !== undefined &&
  location.value !== undefined;

const isXlsxCanary = (
  canary: DataRoomManifest['canaries'][number],
): canary is typeof canary & { location: XlsxCellAddress } =>
  canary.location.sheet !== undefined && canary.location.cell !== undefined;

function findCellElement(
  elements: readonly { locator: { kind: string }; text: string }[],
  sheetName: string,
  cell: string,
) {
  return elements.find(
    (element) =>
      element.locator.kind === 'xlsx-cell' &&
      (element.locator as XlsxCellLocator).sheetName === sheetName &&
      (element.locator as XlsxCellLocator).cell === cell,
  );
}

describe('XlsxParser', () => {
  let parser: XlsxParser;

  beforeEach(() => {
    parser = new XlsxParser();
  });

  describe('parse — comps.xlsx fixture', () => {
    it('should render the seeded conflict cell as the displayed percentage, not the raw fraction', async () => {
      const conflict = manifest.conflict.locations.find(isXlsxConflict);
      if (!conflict) {
        throw new Error('manifest.conflict.locations has no spreadsheet-side entry');
      }
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      const cellElement = findCellElement(result.elements, conflict.sheet, conflict.cell);
      expect(cellElement).toBeDefined();
      // The whole point: the cell stores 0.0525 but the document *says* 5.25%. Conflict
      // detection compares what a reader sees, so the raw fraction must not be what we emit.
      expect(cellElement?.text).toBe(conflict.display);
      expect(cellElement?.text).not.toBe(String(conflict.value));
    });

    it("should surface the canary cell's token, sanitized the same way every other cell is", async () => {
      const canary = manifest.canaries.find(isXlsxCanary);
      if (!canary) {
        throw new Error('manifest.canaries has no spreadsheet-side entry');
      }
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      const canaryElement = findCellElement(
        result.elements,
        canary.location.sheet,
        canary.location.cell,
      );
      expect(canaryElement).toBeDefined();
      expect(canaryElement?.text).toContain(canary.token);

      // Read the same cell independently of the parser under test, so this proves
      // `sanitizeEvidenceText` actually ran on the parser's output rather than merely that the
      // token substring happens to appear somewhere in it.
      const workbook = new ExcelJS.Workbook();
      // Node 26 types `readFile` as `Buffer<ArrayBuffer>` while exceljs still declares the older
      // `Buffer`. Structurally identical at runtime; the cast is the narrowest way to bridge two
      // out-of-step type declarations without loosening either signature.
      await workbook.xlsx.load(content as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.getWorksheet(canary.location.sheet);
      if (!sheet) {
        throw new Error(`fixture is missing sheet ${canary.location.sheet}`);
      }
      const rawText = sheet.getCell(canary.location.cell).text;
      expect(canaryElement?.text).toBe(sanitizeEvidenceText(rawText));
    });

    it('should stamp extractorVersion on the document and on every locator', async () => {
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      expect(result.extractorVersion).toBe('xlsx-exceljs-2');
      expect(result.elements.length).toBeGreaterThan(0);
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('xlsx-exceljs-2');
        expect(element.headingPath).toEqual([]);
      }
    });

    it('should not emit an element for a blank cell', async () => {
      const content = await readFile(FIXTURE_PATH);

      const result = await parser.parse(content);

      // Row 2's Notes cell (H2) has no note in the fixture; a blank-looking cell is not evidence
      // worth citing.
      expect(findCellElement(result.elements, 'Comps', 'H2')).toBeUndefined();
    });
  });

  describe('parse — merged cells', () => {
    // The regression case: exceljs itself already points a covered cell's raw *value* at its
    // master on load, but a covered cell keeps its own numFmt (mergeCellsWithoutStyle at load
    // time never re-copies the master's style). A percent-formatted master with an unformatted
    // covered cell is exactly the divergence that produced a false conflict before this fix —
    // master displays '5.25%', an unformatted covered cell would display the raw '0.0525'.
    it("should give every covered cell the master cell's own display text, not its own numFmt", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 0.0525;
      sheet.getCell('A1').numFmt = '0.00%';
      sheet.mergeCellsWithoutStyle('A1:C1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const master = findCellElement(result.elements, 'Sheet1', 'A1');
      const coveredB1 = findCellElement(result.elements, 'Sheet1', 'B1');
      const coveredC1 = findCellElement(result.elements, 'Sheet1', 'C1');
      expect(master?.text).toBe('5.25%');
      expect(coveredB1?.text).toBe('5.25%');
      expect(coveredC1?.text).toBe('5.25%');
    });

    it('should emit exactly one element per merged cell address, never a duplicate', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Q1 2025 Comparable Sales Report';
      sheet.mergeCells('A1:D1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      for (const address of ['A1', 'B1', 'C1', 'D1']) {
        const matches = result.elements.filter(
          (element) =>
            element.locator.kind === 'xlsx-cell' &&
            element.locator.sheetName === 'Sheet1' &&
            element.locator.cell === address,
        );
        expect(matches).toHaveLength(1);
        expect(matches[0].text).toBe('Q1 2025 Comparable Sales Report');
      }
    });

    it('should not emit an element for any cell covered by a merge whose master is blank', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.mergeCells('A1:B1');
      sheet.getCell('A2').value = 'data';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')).toBeUndefined();
      expect(findCellElement(result.elements, 'Sheet1', 'B1')).toBeUndefined();
    });

    it('should stamp the current extractorVersion on a covered-cell element the same as any other', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Title';
      sheet.mergeCells('A1:B1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const covered = findCellElement(result.elements, 'Sheet1', 'B1');
      expect((covered?.locator as XlsxCellLocator | undefined)?.extractorVersion).toBe(
        'xlsx-exceljs-2',
      );
    });
  });

  describe('parse — hostile archives (fails closed)', () => {
    it('should reject an archive whose entry compression ratio indicates a zip bomb', async () => {
      const zip = new JSZip();
      zip.file('xl/worksheets/sheet1.xml', 'A'.repeat(5_000_000), {
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    it('should reject an archive entry using a path-traversal name', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<sheet/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });
  });

  describe('parse — malformed input', () => {
    it('should reject a buffer that is not a zip archive at all', async () => {
      await expect(parser.parse(Buffer.from('not a zip'))).rejects.toBeInstanceOf(
        MalformedXlsxException,
      );
    });

    it('should resolve with no elements for a valid zip that carries no workbook', async () => {
      const zip = new JSZip();
      zip.file('README.txt', 'not a workbook');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(buffer);

      expect(result.elements).toEqual([]);
    });
  });
});
