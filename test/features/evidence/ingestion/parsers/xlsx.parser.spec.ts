import { randomBytes } from 'node:crypto';
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
import { MAX_FILE_SIZE_BYTES } from '../../../../../src/features/evidence/documents/documents.constant';
import { BaseException } from '../../../../../src/shared/exceptions/base.exception';
import rawManifest from '../../../../../fixtures/data-room/manifest.json';

const FIXTURE_PATH = path.join(__dirname, '../../../../../fixtures/data-room/comps.xlsx');

const CENTRAL_DIRECTORY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE_OFFSET = 24;
const CENTRAL_DIRECTORY_FILE_NAME_LENGTH_OFFSET = 28;
const CENTRAL_DIRECTORY_FIXED_LENGTH = 46;

/**
 * Overwrites the declared uncompressed-size field in `buffer`'s central-directory record for
 * `entryName`, leaving the compressed payload and every other byte untouched. Simulates the one
 * thing a declared-size check cannot see through: a central directory that under-reports what an
 * entry actually inflates to. JSZip reads an entry's real compressed bytes off the (unpatched)
 * local file header using the central directory's compressed-size field, so the entry still
 * decompresses to its true, larger content. Mirrors `docx.parser.spec.ts`'s identically-named
 * helper — duplicated by design, the same as this module's other archive-specific test fixtures.
 */
function lieAboutDeclaredUncompressedSize(
  buffer: Buffer,
  entryName: string,
  liedUncompressedSize: number,
): Buffer {
  const nameBytes = Buffer.from(entryName, 'utf8');
  const patched = Buffer.from(buffer);

  let recordStart = patched.indexOf(CENTRAL_DIRECTORY_SIGNATURE);
  while (recordStart !== -1) {
    const fileNameLength = patched.readUInt16LE(
      recordStart + CENTRAL_DIRECTORY_FILE_NAME_LENGTH_OFFSET,
    );
    const nameStart = recordStart + CENTRAL_DIRECTORY_FIXED_LENGTH;
    const recordName = patched.subarray(nameStart, nameStart + fileNameLength);
    if (recordName.equals(nameBytes)) {
      patched.writeUInt32LE(
        liedUncompressedSize,
        recordStart + CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE_OFFSET,
      );
      return patched;
    }
    recordStart = patched.indexOf(CENTRAL_DIRECTORY_SIGNATURE, recordStart + 4);
  }
  throw new Error(`Fixture has no central-directory record for "${entryName}"`);
}

/**
 * Comfortably past the parser's archive budget while staying small enough that a regression fails
 * on the assertion rather than by exhausting the test runner: a guard that stops working lets one
 * of these through to `workbook.xlsx.load()`, which survives 26MB.
 */
const OVERSIZED_ENTRY_BYTES = 26 * 1024 * 1024;

/**
 * Bulk that compresses well short of `assertSafeArchive`'s 100:1 ratio limit: a fixed slice of
 * random bytes per megabyte keeps the compressed size proportional, so an entry can be large
 * without reading as a zip bomb. Lets a size-limit test declare tens of megabytes without writing
 * tens of megabytes to the archive.
 */
function partlyCompressibleBuffer(totalBytes: number): Buffer {
  const megabyte = 1024 * 1024;
  const randomPerMegabyte = 20 * 1024;
  const blocks: Buffer[] = [];
  for (let written = 0; written < totalBytes; written += megabyte) {
    blocks.push(randomBytes(randomPerMegabyte), Buffer.alloc(megabyte - randomPerMegabyte, 0x41));
  }
  return Buffer.concat(blocks);
}

/**
 * Spies on the `load` shared by every `Workbook#xlsx` instance, so a test can observe whether the
 * parser reached exceljs at all. Calls through, and the caller restores it — the parse paths that
 * legitimately load a workbook run in the same file.
 */
function spyOnWorkbookLoad() {
  const xlsxAccessor = new ExcelJS.Workbook().xlsx;
  const prototype = Object.getPrototypeOf(xlsxAccessor) as Pick<typeof xlsxAccessor, 'load'>;
  return jest.spyOn(prototype, 'load');
}

/**
 * Runs `run` with `range` injected into every loaded worksheet's internal merge store, immediately
 * before the parser's own `eachSheet` callback runs, and restores exceljs afterwards.
 *
 * Injection rather than crafted XML because exceljs's own address decoder is far more lenient than
 * `parseCellAddress`'s strict A1 regex: every malformed `<mergeCell ref>` this suite fed it through
 * real workbook bytes (`a1:b1`, `A:B`, `A0:B0`, `A1:BB`, ...) came back silently re-normalized to a
 * well-formed pair before ever reaching `worksheet.model.merges`.
 */
async function withInjectedMergeRange<T>(range: string, run: () => Promise<T>): Promise<T> {
  // Captured only to be re-invoked below via `.call(this, ...)` with the correct receiver — never
  // called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalEachSheet = ExcelJS.Workbook.prototype.eachSheet;
  ExcelJS.Workbook.prototype.eachSheet = function (
    this: ExcelJS.Workbook,
    callback: (worksheet: ExcelJS.Worksheet, id: number) => void,
  ): void {
    originalEachSheet.call(this, (worksheet, id) => {
      (worksheet as unknown as { _merges: Record<string, { range: string }> })._merges.A1 = {
        range,
      };
      callback(worksheet, id);
    });
  };

  try {
    return await run();
  } finally {
    ExcelJS.Workbook.prototype.eachSheet = originalEachSheet;
  }
}

/**
 * The manifest's `conflicts[].locations` and `canaries` are heterogeneous — a spreadsheet entry
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
  readonly conflicts: readonly {
    readonly locations: readonly ({ readonly file: string } & Partial<XlsxCellAddress> & {
        readonly value?: number;
        readonly display?: string;
      })[];
  }[];
  readonly canaries: readonly {
    readonly file: string;
    readonly token: string;
    readonly location: Partial<XlsxCellAddress> & { readonly page?: number };
  }[];
}

const manifest = rawManifest as DataRoomManifest;

const isXlsxConflict = (
  location: DataRoomManifest['conflicts'][number]['locations'][number],
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
  elements: readonly { locator: { kind: string }; text: string; mergeCovered?: true }[],
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
      const conflict = manifest.conflicts[0].locations.find(isXlsxConflict);
      if (!conflict) {
        throw new Error('manifest.conflicts[0].locations has no spreadsheet-side entry');
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

    it('should mark a merge-covered cell with mergeCovered, and leave it absent on the master cell', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Title';
      sheet.mergeCells('A1:B1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const master = findCellElement(result.elements, 'Sheet1', 'A1');
      const covered = findCellElement(result.elements, 'Sheet1', 'B1');
      expect(master?.mergeCovered).toBeUndefined();
      expect(covered?.mergeCovered).toBe(true);
    });
  });

  describe('parse — number formatting', () => {
    // Regression: `#,##0;(#,##0)` previously produced "-(41,000" — a leading minus AND an
    // unclosed opening paren, neither a real minus sign nor the accounting convention it was
    // meant to render.
    it('should render an accounting-format negative as a parenthesized figure, not a garbled minus-and-paren', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = -41000;
      sheet.getCell('A1').numFmt = '#,##0;(#,##0)';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const cellElement = findCellElement(result.elements, 'Sheet1', 'A1');
      expect(cellElement?.text).toBe('(41,000)');
    });

    it('should render an accounting-format currency negative with the prefix inside the parens', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = -41000;
      sheet.getCell('A1').numFmt = '$#,##0;($#,##0)';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const cellElement = findCellElement(result.elements, 'Sheet1', 'A1');
      expect(cellElement?.text).toBe('($41,000)');
    });

    it('should leave an ordinary single-section negative format unaffected', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = -41000;
      sheet.getCell('A1').numFmt = '#,##0.00';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const cellElement = findCellElement(result.elements, 'Sheet1', 'A1');
      expect(cellElement?.text).toBe('-41,000.00');
    });

    /**
     * A number format is attacker-controlled metadata, and the decimal count read out of it feeds
     * `toFixed`, whose domain stops at 100 digits. The sweep crosses that boundary rather than
     * sampling one value past it: a format asking for more decimals than the API accepts renders
     * at the API's ceiling, and never escapes as a `RangeError`.
     */
    it.each([0, 1, 30, 99, 100, 101, 150, 1000])(
      'should render a number format declaring %i decimal places at the digit ceiling instead of throwing',
      async (declaredDecimals) => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet1');
        sheet.getCell('A1').value = 1.5;
        sheet.getCell('A1').numFmt =
          declaredDecimals === 0 ? '0' : `0.${'0'.repeat(declaredDecimals)}`;
        const content = Buffer.from(await workbook.xlsx.writeBuffer());

        const result = await parser.parse(content);

        expect(findCellElement(result.elements, 'Sheet1', 'A1')?.text).toBe(
          (1.5).toFixed(Math.min(declaredDecimals, 100)),
        );
      },
    );

    // Every value this parser derives from format metadata reaches an API with its own domain, so
    // the property under test is the module's error contract itself: a crafted format is bad input
    // (a 400 this module raises), never an unhandled failure that reaches the caller as a 500.
    it.each([
      `0.${'0'.repeat(150)}`,
      `#,##0.${'0'.repeat(400)}%`,
      `${'$'.repeat(500)}#,##0.00`,
      `0.${'0'.repeat(120)};(0.${'0'.repeat(120)})`,
      ';;;',
      '(',
      '[$-409]0.00',
    ])(
      'should keep a crafted number format "%s" inside this module\'s error contract',
      async (numFmt) => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet1');
        sheet.getCell('A1').value = -1234.5;
        sheet.getCell('A1').numFmt = numFmt;
        const content = Buffer.from(await workbook.xlsx.writeBuffer());

        const failure: unknown = await parser.parse(content).then(
          () => undefined,
          (error: unknown) => error,
        );

        if (failure !== undefined) {
          expect(failure).toBeInstanceOf(BaseException);
        }
        expect(failure).not.toBeInstanceOf(RangeError);
        expect(failure).not.toBeInstanceOf(TypeError);
      },
    );
  });

  describe('parse — formula errors are not evidence', () => {
    it('should not emit an element for a cell holding a raw error value', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = { error: '#DIV/0!' };
      sheet.getCell('A2').value = 'data';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')).toBeUndefined();
      expect(findCellElement(result.elements, 'Sheet1', 'A2')).toBeDefined();
    });

    it('should not propagate a formula error across a merge master', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = { error: '#REF!' };
      sheet.mergeCellsWithoutStyle('A1:B1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')).toBeUndefined();
      expect(findCellElement(result.elements, 'Sheet1', 'B1')).toBeUndefined();
    });
  });

  describe('parse — merge ranges the parser would never have written itself', () => {
    it('should skip a merge range with a malformed cell address and record a reduced-fidelity reason, while the rest of the workbook survives', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Title';
      sheet.getCell('A2').value = 'data';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await withInjectedMergeRange('A1:BB', () => parser.parse(content));

      expect(findCellElement(result.elements, 'Sheet1', 'A1')).toBeDefined();
      expect(findCellElement(result.elements, 'Sheet1', 'A2')).toBeDefined();
      expect(findCellElement(result.elements, 'Sheet1', 'B1')).toBeUndefined();
      expect(result.reducedFidelityReasons).toBeDefined();
      expect(result.reducedFidelityReasons?.[0]).toContain('malformed cell address');
    });

    // `XFE` is column 16385, one past the last column Excel addresses, in a one-cell rectangle
    // that clears the merge-range cap. exceljs answers `getCell` for it with a bare `Error`,
    // which without the parser's own contract would surface as a 500 for what is a defect in the
    // uploaded file.
    it('should reject a merge range addressing a column beyond the sheet as bad input, not as an unhandled failure', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Title';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const failure: unknown = await withInjectedMergeRange('XFE1:XFE1', () =>
        parser.parse(content).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      expect(failure).toBeInstanceOf(MalformedXlsxException);
    });
  });

  /**
   * Two budgets, and the tests that keep them from collapsing into one: worksheet XML becomes
   * exceljs's object graph and is held to the tighter limit, while the rest of the package — media
   * above all — is only ever held to the archive-wide backstop, which sits above the upload gate's
   * own limit so that nothing the API accepted can be refused here for its size.
   */
  describe('parse — size budgets (too large, not hostile)', () => {
    it.each(['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml'])(
      'should reject a workbook whose %s honestly declares more than the worksheet budget, as MalformedXlsxException rather than HostileArchiveException',
      async (entryName) => {
        const zip = new JSZip();
        // STORE (no compression): declared and real bytes match, so `assertSafeArchive`'s
        // compression-ratio check sees nothing suspicious — this is a size limit, not a bomb.
        zip.file(entryName, 'A'.repeat(OVERSIZED_ENTRY_BYTES), { compression: 'STORE' });
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });

        await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedXlsxException);
        await expect(parser.parse(buffer)).rejects.not.toBeInstanceOf(HostileArchiveException);
        await expect(parser.parse(buffer)).rejects.toThrow(/worksheet data/);
      },
    );

    // The contract this parser sits behind: `MAX_FILE_SIZE_BYTES` is what the upload endpoint
    // accepts, and a photo-carrying data-room workbook is bulk in media, not in worksheet XML.
    // Refusing it here would mean the product accepting a file it then cannot read.
    it('should parse a workbook whose media carries it close to the upload limit', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'photographed';
      const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
      // Random bytes stored uncompressed, the way an already-compressed JPEG sits in a zip:
      // declared size, real size and compressed size all agree, and none of them is small.
      zip.file('xl/media/image1.jpeg', randomBytes(MAX_FILE_SIZE_BYTES - 2 * 1024 * 1024), {
        compression: 'STORE',
      });
      const content = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')?.text).toBe('photographed');
    }, 60_000);

    it('should reject a workbook whose parts together declare more than the archive budget', async () => {
      const zip = new JSZip();
      // Four entries of the same bulk, each compressing at a ratio `assertSafeArchive` accepts, so
      // the refusal comes from the archive-wide total rather than from any single entry.
      const bulk = partlyCompressibleBuffer(21 * 1024 * 1024);
      for (let index = 1; index <= 4; index += 1) {
        zip.file(`xl/media/image${index}.png`, bulk, {
          compression: 'DEFLATE',
          compressionOptions: { level: 1 },
        });
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(MalformedXlsxException);
      await expect(parser.parse(buffer)).rejects.not.toBeInstanceOf(HostileArchiveException);
    }, 60_000);
  });

  /**
   * The sweep, not a reproduction: `workbook.xlsx.load()` fully materializes every non-directory
   * entry an archive contains before it decides what the entry is, so the guard's domain is every
   * entry name — not the subset a reported crash happened to name. Each case under-declares one
   * entry that really inflates past the budget and asserts the parse is refused before `load()`
   * ever runs; the spy on `load` is what proves "before", since a guard that rejects afterwards
   * has already paid the memory it exists to prevent.
   */
  describe('parse — under-declared entry, swept over the whole package (fails closed)', () => {
    const OOXML_PACKAGE_ENTRY_NAMES = [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'docProps/custom.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/calcChain.xml',
      'xl/metadata.xml',
      'xl/theme/theme1.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
      'xl/drawings/drawing1.xml',
      'xl/drawings/_rels/drawing1.xml.rels',
      'xl/drawings/vmlDrawing1.vml',
      'xl/media/image1.png',
      'xl/comments1.xml',
      'xl/tables/table1.xml',
      'xl/persons/person1.xml',
      'customXml/item1.xml',
      'customXml/itemProps1.xml',
      // Names exceljs recognizes nothing about are in scope too: it inflates every entry into
      // memory first and only then matches the name, so an unrecognized part costs exactly the
      // same as a worksheet.
      'unrecognised/part.bin',
      'xl/worksheets/sheet1.xml.bak',
    ];

    it.each(OOXML_PACKAGE_ENTRY_NAMES)(
      'should refuse an archive whose "%s" under-declares its uncompressed size, before workbook.xlsx.load() is reached',
      async (entryName) => {
        const zip = new JSZip();
        // Real, honestly-compressed payload: DEFLATE keeps the on-disk archive small while the
        // entry still inflates to well past the budget once decompressed.
        zip.file(entryName, 'A'.repeat(OVERSIZED_ENTRY_BYTES), {
          compression: 'DEFLATE',
          compressionOptions: { level: 1 },
        });
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        // The central directory now claims 4096 uncompressed bytes for an entry that really
        // inflates to 26MB. The compressed bytes and CRC are untouched and honest, so
        // `assertSafeArchive`'s ratio check (declared uncompressed ÷ declared compressed) sees a
        // ratio under 1:1, not the 100:1+ it looks for, and every declared-size pass sees only
        // the lie. Real inflated bytes are the only thing left that can catch it.
        const lyingBuffer = lieAboutDeclaredUncompressedSize(buffer, entryName, 4096);
        const loadSpy = spyOnWorkbookLoad();

        try {
          await expect(parser.parse(lyingBuffer)).rejects.toBeInstanceOf(HostileArchiveException);
          expect(loadSpy).not.toHaveBeenCalled();
        } finally {
          loadSpy.mockRestore();
        }
      },
    );

    it('should still parse a workbook whose entries all declare their true size', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'honest';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')?.text).toBe('honest');
    });
  });

  describe('parse — hostile archives (fails closed)', () => {
    /**
     * A high compression ratio is a property of repetitive text, not of an attack: a workbook of
     * repeated boilerplate genuinely deflates several hundred to one. The parse must turn on the
     * bytes the entry really inflates to, which this one keeps well inside the budget.
     */
    it('should parse a workbook whose repetitive text compresses far past a hundred to one', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      const filler = 'x'.repeat(2_200);
      for (let row = 1; row <= 2_000; row += 1) {
        sheet.getCell(row, 1).value = `${filler}-${row}`;
      }
      const content = Buffer.from(await workbook.xlsx.writeBuffer());
      const reloaded = await JSZip.loadAsync(content);
      // The repetition lands in the shared-string table, not the sheet: exceljs writes each
      // distinct string once and the sheet carries indices.
      const sizes = (
        reloaded.files['xl/sharedStrings.xml'] as unknown as {
          _data: { compressedSize: number; uncompressedSize: number };
        }
      )._data;

      const result = await parser.parse(content);

      expect(sizes.uncompressedSize / sizes.compressedSize).toBeGreaterThan(100);
      expect(result.elements).toHaveLength(2_000);
    }, 60_000);

    it('should reject an archive entry using a path-traversal name', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<sheet/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });

    // A merge range and an element count state their own extent and cannot state it falsely, so
    // both refusals are capacity limits — see the refusal-class sweep for the full axis.
    it('should reject a merge range whose rectangle exceeds the cell cap as capacity', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Title';
      // 10 columns x 1000 rows = 10,000 covered cells, past the parser's merge-rectangle cap —
      // a tiny declared archive that would otherwise expand to a large emitted-element cost.
      sheet.mergeCells('A1:J1000');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      await expect(parser.parse(content)).rejects.toBeInstanceOf(MalformedXlsxException);
      await expect(parser.parse(content)).rejects.not.toBeInstanceOf(HostileArchiveException);
      await expect(parser.parse(content)).rejects.toThrow(/split|trim/i);
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

  /**
   * The number-format sweep, not a case list. The domain is the section grammar itself — how many
   * `;`-separated sections a format declares, which of them a given value selects, and the token
   * vocabulary each section may carry — so the sweep is the cross product of those axes rather
   * than one test per shape someone happened to report.
   *
   * Two properties hold over every generated case, and they are the parser's whole contract:
   *
   * 1. **No format token reaches cell text.** `_`, `*`, `\`, `"`, `[`, `]`, `@`, `#` and `?` are
   *    grammar, never content. None of the generated formats hides one of those characters inside
   *    a quoted literal, so any occurrence in the output is a token that leaked.
   * 2. **The figure survives.** Stripping presentation (currency, grouping, parens, percent) from
   *    the emitted text recovers the cell's own value, at the precision and scale the chosen
   *    section declares — or the parse records a `reducedFidelityReasons` entry naming the format.
   *    Never a third outcome.
   */
  describe('parse — number-format grammar sweep', () => {
    /** Literals a section may open with: currency, colour, skip-width and repeat-fill tokens. */
    const SECTION_PREFIXES = ['', '$', '"USD "', '[$$-409]', '[Red]', '_-', '* ', '_-* ', '\\$'];
    /** The digit runs: with and without thousands grouping, with and without a fraction. */
    const SECTION_BODIES = ['0', '0.00', '#,##0', '#,##0.00'];
    /** Literals a section may close with, including the percent scaler. */
    const SECTION_SUFFIXES = ['', '%', '_-', '* ', '"M"'];

    /**
     * How a negative section carries its sign. Excel applies the negative section verbatim, so a
     * section that names no sign renders a negative value unsigned — `plain` is that case, and it
     * is the one an implementation that injects its own minus gets wrong.
     */
    type NegativeStyle = 'plain' | 'minus' | 'parens';
    const NEGATIVE_STYLES: readonly NegativeStyle[] = ['plain', 'minus', 'parens'];

    interface FormatCase {
      readonly address: string;
      readonly numFmt: string;
      readonly value: number;
      readonly sectionCount: number;
      readonly negativeStyle: NegativeStyle;
      readonly section: string;
      readonly decimals: number;
      readonly percent: boolean;
    }

    const SWEEP_VALUES = [12_500, -3200.5, 0] as const;

    function negativeSection(base: string, style: NegativeStyle): string {
      if (style === 'minus') {
        return `-${base}`;
      }
      if (style === 'parens') {
        return `(${base})`;
      }
      return base;
    }

    /**
     * Which section a value selects, per Excel's section grammar: one section formats everything,
     * two split positive-or-zero from negative, three or more give zero its own section.
     */
    function selectSection(sections: readonly string[], value: number): string {
      if (sections.length === 1) {
        return sections[0];
      }
      if (value < 0) {
        return sections[1];
      }
      if (value === 0 && sections.length > 2) {
        return sections[2];
      }
      return sections[0];
    }

    /** Counts the fraction digits a section declares — the sweep's own reading of the format. */
    function declaredDecimals(section: string): number {
      const match = /\.([0#?]+)/.exec(section);
      return match ? match[1].length : 0;
    }

    function buildCases(): FormatCase[] {
      const cases: FormatCase[] = [];
      let index = 0;
      for (const prefix of SECTION_PREFIXES) {
        for (const body of SECTION_BODIES) {
          for (const suffix of SECTION_SUFFIXES) {
            const base = `${prefix}${body}${suffix}`;
            for (let sectionCount = 1; sectionCount <= 4; sectionCount += 1) {
              const negativeStyle = NEGATIVE_STYLES[index % NEGATIVE_STYLES.length];
              const sections = [base];
              if (sectionCount > 1) {
                sections.push(negativeSection(base, negativeStyle));
              }
              if (sectionCount > 2) {
                sections.push(base);
              }
              if (sectionCount > 3) {
                sections.push('@');
              }
              const numFmt = sections.join(';');
              for (const value of SWEEP_VALUES) {
                index += 1;
                const section = selectSection(sections, value);
                cases.push({
                  address: `A${index}`,
                  numFmt,
                  value,
                  sectionCount,
                  negativeStyle,
                  section,
                  decimals: declaredDecimals(section),
                  percent: section.includes('%'),
                });
              }
            }
          }
        }
      }
      return cases;
    }

    const FORMAT_TOKEN_PATTERN = /[_*\\"[\]@#?]/;

    let sweepCases: FormatCase[];
    let sweepResult: Awaited<ReturnType<XlsxParser['parse']>>;

    beforeAll(async () => {
      sweepCases = buildCases();
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sweep');
      for (const formatCase of sweepCases) {
        const cell = sheet.getCell(formatCase.address);
        cell.value = formatCase.value;
        cell.numFmt = formatCase.numFmt;
      }
      const content = Buffer.from(await workbook.xlsx.writeBuffer());
      sweepResult = await new XlsxParser().parse(content);
    }, 120_000);

    it('should emit a figure for every generated number format, never a format token', () => {
      const leaked = sweepCases.filter((formatCase) => {
        const text = findCellElement(sweepResult.elements, 'Sweep', formatCase.address)?.text ?? '';
        return FORMAT_TOKEN_PATTERN.test(text);
      });

      expect(
        leaked.map((formatCase) => ({
          numFmt: formatCase.numFmt,
          value: formatCase.value,
          text: findCellElement(sweepResult.elements, 'Sweep', formatCase.address)?.text,
        })),
      ).toEqual([]);
    });

    it('should recover each cell value from the emitted text at the precision its section declares', () => {
      const wrong = sweepCases
        .map((formatCase) => {
          const text =
            findCellElement(sweepResult.elements, 'Sweep', formatCase.address)?.text ?? '';
          const digits = text.replace(/[^0-9.]/g, '');
          const magnitude = digits === '' || digits === '.' ? 0 : Number(digits);
          const scaled = Math.abs(formatCase.value) * (formatCase.percent ? 100 : 1);
          const expected = Number(scaled.toFixed(formatCase.decimals));
          return { formatCase, text, magnitude, expected };
        })
        .filter((observed) => observed.magnitude !== observed.expected);

      expect(
        wrong.map((observed) => ({
          numFmt: observed.formatCase.numFmt,
          value: observed.formatCase.value,
          text: observed.text,
          expected: observed.expected,
        })),
      ).toEqual([]);
    });

    it('should sign a negative exactly as its own section does, never adding a sign the section does not carry', () => {
      const negatives = sweepCases.filter((formatCase) => formatCase.value < 0);
      const wrong = negatives
        .map((formatCase) => {
          const text =
            findCellElement(sweepResult.elements, 'Sweep', formatCase.address)?.text ?? '';
          const shown = text.startsWith('-') || (text.startsWith('(') && text.endsWith(')'));
          // One section has no negative section to apply, so the sign is the parser's to supply;
          // two or more sections mean the negative section itself decides.
          const expected =
            formatCase.sectionCount === 1 ? true : formatCase.negativeStyle !== 'plain';
          return { formatCase, text, shown, expected };
        })
        .filter((observed) => observed.shown !== observed.expected);

      expect(
        wrong.map((observed) => ({
          numFmt: observed.formatCase.numFmt,
          text: observed.text,
          signExpected: observed.expected,
        })),
      ).toEqual([]);
    });

    it('should record no reduced-fidelity reason for a format built only from tokens it reproduces', () => {
      expect(sweepResult.reducedFidelityReasons).toBeUndefined();
    });

    /**
     * The shapes a reader can check against Excel by eye, asserted as exact text. The first three
     * are the genuine four-section Accounting format Excel's own number-format gallery writes; the
     * fourth and fifth are built-in format 44 and the two-section shape.
     */
    it.each([
      ['_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-', 12_500, '12,500.00'],
      ['_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-', -3200.5, '-3,200.50'],
      ['_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-', 0, '-'],
      ['_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)', 12_500, '$12,500.00'],
      ['_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)', -3200.5, '$(3,200.50)'],
      ['_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)', 0, '$-'],
      ['#,##0;(#,##0)', -41_000, '(41,000)'],
      ['$#,##0;($#,##0)', -41_000, '($41,000)'],
      ['#,##0.00', -41_000, '-41,000.00'],
      ['0.00%', 0.0525, '5.25%'],
      ['0.00;0.00', -3200.5, '3200.50'],
      ['#,##0,,"M"', 12_000_000, '12M'],
      ['#,##0.0,', 12_500, '12.5'],
      ['0;-0;"zero"', 0, 'zero'],
      ['0;-0;"zero";@', 7, '7'],
      ['[Red]#,##0.00;[Blue]-#,##0.00', -3200.5, '-3,200.50'],
      ['[$€-407]#,##0.00', 1234.5, '€1,234.50'],
    ])(
      'should render numFmt "%s" holding %d as the text a reader sees',
      async (numFmt, value, expected) => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet1');
        sheet.getCell('A1').value = value;
        sheet.getCell('A1').numFmt = numFmt;
        const content = Buffer.from(await workbook.xlsx.writeBuffer());

        const result = await parser.parse(content);

        expect(findCellElement(result.elements, 'Sheet1', 'A1')?.text).toBe(expected);
        expect(result.reducedFidelityReasons).toBeUndefined();
      },
    );

    it('should emit nothing for an all-empty-section format, the way Excel renders a blank cell', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 12_500;
      sheet.getCell('A1').numFmt = ';;;';
      sheet.getCell('A2').value = 'visible';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')).toBeUndefined();
      expect(findCellElement(result.elements, 'Sheet1', 'A2')).toBeDefined();
    });

    /**
     * The refusal side of the same invariant. These formats carry grammar this parser does not
     * reproduce — scientific notation, fractions, digit placeholders interleaved with literals,
     * conditional sections, and optional fraction digits whose trailing-separator rendering this
     * parser does not claim to match Excel on. Each must surface as a reduced-fidelity reason
     * naming the format, never as a best guess and never as a leaked token.
     */
    it.each([
      '0.00E+00',
      '# ?/?',
      '000-000-0000',
      '0"-"0',
      '[<100]0.00;[>=100]#,##0',
      '0.##',
      '#,##0.0#',
      '0.0??',
    ])('should refuse numFmt "%s" visibly instead of guessing at it', async (numFmt) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = -3200.5;
      sheet.getCell('A1').numFmt = numFmt;
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      const text = findCellElement(result.elements, 'Sheet1', 'A1')?.text ?? '';
      expect(text).not.toMatch(FORMAT_TOKEN_PATTERN);
      expect(result.reducedFidelityReasons?.some((reason) => reason.includes(numFmt))).toBe(true);
    });

    it.each(['yyyy-mm-dd', '[h]:mm:ss', 'mmm d, yyyy'])(
      'should either render a date-formatted number as a date or refuse numFmt "%s" visibly',
      async (numFmt) => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Sheet1');
        sheet.getCell('A1').value = 45_000;
        sheet.getCell('A1').numFmt = numFmt;
        const content = Buffer.from(await workbook.xlsx.writeBuffer());

        const result = await parser.parse(content);

        const text = findCellElement(result.elements, 'Sheet1', 'A1')?.text ?? '';
        expect(text).not.toMatch(FORMAT_TOKEN_PATTERN);
        const renderedAsDate = /^\d{4}-\d{2}-\d{2}$/.test(text);
        const refused = result.reducedFidelityReasons?.some((reason) => reason.includes(numFmt));
        expect(renderedAsDate || refused === true).toBe(true);
      },
    );

    it('should record one reduced-fidelity reason per distinct unsupported format, not one per cell', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      for (let row = 1; row <= 500; row += 1) {
        const cell = sheet.getCell(row, 1);
        cell.value = row + 0.5;
        cell.numFmt = '0.00E+00';
      }
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(result.reducedFidelityReasons).toHaveLength(1);
    });

    it('should apply the same unsupported-format refusal to a merge master as to an ordinary cell', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 1234.5;
      sheet.getCell('A1').numFmt = '0.00E+00';
      sheet.mergeCellsWithoutStyle('A1:B1');
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'B1')?.text).not.toMatch(
        FORMAT_TOKEN_PATTERN,
      );
      expect(result.reducedFidelityReasons?.some((reason) => reason.includes('0.00E+00'))).toBe(
        true,
      );
    });

    it("should leave a text cell untouched by a four-section format's text section", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      sheet.getCell('A1').value = 'Base Rent';
      sheet.getCell('A1').numFmt = '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-';
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(findCellElement(result.elements, 'Sheet1', 'A1')?.text).toBe('Base Rent');
    });
  });

  /**
   * The refusal-class sweep. A limit is a **capacity** refusal when honest content can reach it —
   * an element count, a cell size, a repetition ratio and a declared byte total are all things a
   * workbook simply is, and none of them can be a lie. A limit is a **hostility** refusal only
   * when the archive's own claim about itself is contradicted by what it really inflates to.
   *
   * The sweep runs both axes: honest bulk across row count, column count, cell size and repetition
   * ratio, which must parse or refuse as capacity and never as hostility; and archives that
   * under-declare a part's size, which must refuse as hostility every time.
   */
  describe('parse — refusal class sweep (honest bulk is capacity, a lie is hostility)', () => {
    interface HonestShape {
      readonly name: string;
      readonly rows: number;
      readonly columns: number;
      readonly cellChars: number;
      readonly repetitive: boolean;
    }

    const HONEST_SHAPES: readonly HonestShape[] = [
      { name: 'small unique', rows: 500, columns: 2, cellChars: 12, repetitive: false },
      { name: 'small repetitive', rows: 500, columns: 2, cellChars: 12, repetitive: true },
      {
        name: 'rent-roll depth, unique',
        rows: 10_001,
        columns: 2,
        cellChars: 12,
        repetitive: false,
      },
      {
        name: 'rent-roll depth, repetitive',
        rows: 10_001,
        columns: 2,
        cellChars: 12,
        repetitive: true,
      },
      { name: 'comps width', rows: 2_000, columns: 15, cellChars: 16, repetitive: false },
      {
        name: 'transaction history width',
        rows: 3_000,
        columns: 30,
        cellChars: 10,
        repetitive: false,
      },
      {
        name: 'wide repetitive cells',
        rows: 1_000,
        columns: 1,
        cellChars: 2_200,
        repetitive: true,
      },
      { name: 'wide unique cells', rows: 1_000, columns: 1, cellChars: 2_200, repetitive: false },
      {
        name: 'very wide repetitive cells',
        rows: 200,
        columns: 1,
        cellChars: 20_000,
        repetitive: true,
      },
      {
        name: 'notes column, deep and repetitive',
        rows: 5_000,
        columns: 1,
        cellChars: 2_200,
        repetitive: true,
      },
    ];

    function cellText(shape: HonestShape, row: number, column: number): string {
      if (shape.repetitive) {
        return 'x'.repeat(shape.cellChars);
      }
      const seed = `${row}-${column}-`;
      // Deterministic, low-repetition filler: a rotating alphabet slice per cell keeps the
      // shared-string table from compressing the way `repetitive` deliberately does.
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let text = seed;
      for (let index = text.length; index < shape.cellChars; index += 1) {
        text += alphabet[(row * 31 + column * 7 + index) % alphabet.length];
      }
      return text.slice(0, Math.max(shape.cellChars, seed.length));
    }

    async function buildHonestWorkbook(shape: HonestShape): Promise<Buffer> {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Bulk');
      for (let row = 1; row <= shape.rows; row += 1) {
        for (let column = 1; column <= shape.columns; column += 1) {
          sheet.getCell(row, column).value = cellText(shape, row, column);
        }
      }
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    it.each(HONEST_SHAPES.map((shape) => [shape.name, shape] as const))(
      'should treat an honest %s workbook as capacity, never as a hostile archive',
      async (_name, shape) => {
        const content = await buildHonestWorkbook(shape);

        const failure: unknown = await parser.parse(content).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).not.toBeInstanceOf(HostileArchiveException);
        if (failure !== undefined) {
          expect(failure).toBeInstanceOf(MalformedXlsxException);
          // A capacity refusal an operator can act on: it must say what to do about it.
          expect((failure as Error).message).toMatch(/split|trim|smaller/i);
        }
      },
      180_000,
    );

    it('should refuse an honestly oversized workbook as capacity with actionable guidance', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Bulk');
      for (let row = 1; row <= 200_001; row += 1) {
        sheet.getCell(row, 1).value = 'x';
      }
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const failure: unknown = await parser.parse(content).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(MalformedXlsxException);
      expect(failure).not.toBeInstanceOf(HostileArchiveException);
      expect((failure as Error).message).toMatch(/split|trim|smaller/i);
    }, 300_000);

    it('should parse a rent-roll-shaped workbook that the old element cap refused', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Rent Roll');
      for (let row = 1; row <= 10_000; row += 1) {
        sheet.getCell(row, 1).value = `Unit ${row}`;
        sheet.getCell(row, 2).value = 1_000 + row;
      }
      const content = Buffer.from(await workbook.xlsx.writeBuffer());

      const result = await parser.parse(content);

      expect(result.elements).toHaveLength(20_000);
    }, 180_000);

    /**
     * The lying axis. Each case declares one size in the central directory and inflates to
     * another; that contradiction is the only thing in this parser's input that an archive cannot
     * be honest about, and it is the sole justification for the hostile class.
     *
     * The declared sizes start at one byte rather than zero. JSZip reads an entry declaring zero
     * uncompressed bytes as an empty entry rather than as compressed content, so the parser's
     * guards see no payload and no contradiction — and a genuinely empty part in an OOXML package
     * is indistinguishable from that at the central directory. Zero therefore exercises JSZip's
     * own handling, not this parser's.
     */
    it.each([
      ['xl/worksheets/sheet1.xml', 1],
      ['xl/worksheets/sheet1.xml', 2],
      ['xl/worksheets/sheet1.xml', 4096],
      ['xl/sharedStrings.xml', 4096],
      ['xl/styles.xml', 1024],
      ['xl/media/image1.png', 64],
      ['docProps/app.xml', 4096],
      ['unrecognised/part.bin', 4096],
    ])(
      'should refuse an archive under-declaring "%s" as %i bytes as hostile',
      async (entryName, liedSize) => {
        const zip = new JSZip();
        zip.file(entryName, 'A'.repeat(OVERSIZED_ENTRY_BYTES), {
          compression: 'DEFLATE',
          compressionOptions: { level: 1 },
        });
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        const lyingBuffer = lieAboutDeclaredUncompressedSize(buffer, entryName, liedSize);

        await expect(parser.parse(lyingBuffer)).rejects.toBeInstanceOf(HostileArchiveException);
      },
      60_000,
    );

    it('should refuse an archive whose entry name lies about its location as hostile', async () => {
      const zip = new JSZip();
      zip.file('../../etc/evil.xml', '<sheet/>');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(parser.parse(buffer)).rejects.toBeInstanceOf(HostileArchiveException);
    });
  });
});
