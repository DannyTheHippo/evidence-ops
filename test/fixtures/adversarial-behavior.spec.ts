import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildDeeplyNestedEmail,
  buildManyAttachmentEmail,
  buildMultipartEmail,
  buildOversizeAttachmentEmail,
  buildOversizeTotalEmail,
} from '../../scripts/fixtures/adversarial/lib/build-email-fixtures';
import {
  buildHundredKRowXlsx,
  buildWideCellWorksheetByteBudgetXlsx,
} from '../../scripts/fixtures/adversarial/lib/build-huge-xlsx';
import {
  buildOversizeHtml,
  buildTwentyMebibyteHtml,
} from '../../scripts/fixtures/adversarial/lib/build-html-fixtures';
import {
  contentMatchesDeclaredKind,
  MAX_FILE_SIZE_BYTES,
  resolveUploadKind,
} from '../../src/features/evidence/documents/documents.constant';
import {
  HostileEmailException,
  MalformedEmailException,
  MalformedHtmlException,
} from '../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import {
  EMAIL_CONTAINER_LIMITS,
  parseEmailMessage,
} from '../../src/features/evidence/ingestion/parsers/email-mime';
import { CsvParser } from '../../src/features/evidence/ingestion/parsers/csv.parser';
import { DocxParser } from '../../src/features/evidence/ingestion/parsers/docx.parser';
import {
  HTML_MAX_BYTES,
  HtmlParser,
} from '../../src/features/evidence/ingestion/parsers/html.parser';
import { HostileArchiveException } from '../../src/features/evidence/ingestion/parsers/safe-zip';
import {
  EmptyPdfTextLayerException,
  MalformedPdfException,
  PdfParser,
} from '../../src/features/evidence/ingestion/parsers/pdf.parser';
import {
  MalformedXlsxException,
  XlsxParser,
} from '../../src/features/evidence/ingestion/parsers/xlsx.parser';
import type {
  DocumentParser,
  ParsedDocument,
} from '../../src/features/evidence/ingestion/parsers/parsed-element.type';

const FIXTURE_DIR = path.join(__dirname, '../../fixtures/adversarial');

const csvParser = new CsvParser(',', ['text/csv']);
const docxParser = new DocxParser();
const htmlParser = new HtmlParser();
const pdfParser = new PdfParser();
const xlsxParser = new XlsxParser();

interface Outcome {
  readonly fixture: string;
  readonly result: 'parsed' | 'threw';
  readonly detail: string;
}

async function observe(fixture: string, parser: DocumentParser, buffer: Buffer): Promise<Outcome> {
  try {
    const parsed = await parser.parse(buffer);
    return {
      fixture,
      result: 'parsed',
      detail: summarizeParsed(parsed),
    };
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return { fixture, result: 'threw', detail: `${name}: ${message}` };
  }
}

function summarizeParsed(parsed: ParsedDocument): string {
  const reasons = parsed.reducedFidelityReasons ?? [];
  return (
    `${parsed.elements.length} element(s)` +
    (reasons.length > 0
      ? `, reducedFidelityReasons=${JSON.stringify(reasons)}`
      : ', no reducedFidelityReasons')
  );
}

async function readFixture(relativePath: string): Promise<Buffer> {
  return readFile(path.join(FIXTURE_DIR, relativePath));
}

function findCellElement(
  result: ParsedDocument,
  sheetName: string,
  cell: string,
): ParsedDocument['elements'][number] | undefined {
  return result.elements.find(
    (element) =>
      element.locator.kind === 'xlsx-cell' &&
      element.locator.sheetName === sheetName &&
      element.locator.cell === cell,
  );
}

/**
 * Runs every real parser (`csv.parser.ts`, `docx.parser.ts`, `pdf.parser.ts`, `xlsx.parser.ts`)
 * against the adversarial fixture tree and records what each one **actually** produces — a
 * terminal parse (with its elements and `reducedFidelityReasons`) or a thrown exception (with its
 * concrete type). This is the "behaviour table" 5d's own text calls for: read-only imports of the
 * ingestion parsers this step does not own the right to edit, exercised against fixtures this step
 * does own.
 */
describe('adversarial fixture parser behaviour', () => {
  const observations: Outcome[] = [];

  afterAll(() => {
    console.table(observations);
  });

  it('a two-column, 100k-row xlsx refuses as a capacity limit, naming the cell cap and what to do about it', async () => {
    const buffer = await buildHundredKRowXlsx();
    const outcome = await observe(
      'adversarial/100k-row.xlsx (in-memory, not committed)',
      xlsxParser,
      buffer,
    );
    observations.push(outcome);
    const failure: unknown = await xlsxParser.parse(buffer).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Two ordinary columns a hundred thousand rows deep is an ordinary data-room export, and it
    // crosses `MAX_TOTAL_EMITTED_ELEMENTS`. A cell count is what a workbook is and cannot be
    // stated falsely, so the refusal is a capacity limit carrying guidance an operator can act
    // on — never the hostile class, which belongs to archives that misdeclare themselves.
    expect(outcome.result).toBe('threw');
    expect(failure).toBeInstanceOf(MalformedXlsxException);
    expect(failure).not.toBeInstanceOf(HostileArchiveException);
    expect(outcome.detail).toContain('MalformedXlsxException');
    expect(outcome.detail).toContain('more than 200000 cells');
    expect(outcome.detail).toContain('split the workbook or trim it to a smaller extract');
  }, 120_000);

  it('a wide-cell xlsx (few cells, large repetitive cells) reaches the worksheet-byte budget and refuses as a capacity limit', async () => {
    const buffer = await buildWideCellWorksheetByteBudgetXlsx();
    const outcome = await observe(
      'adversarial/wide-cell-worksheet-budget.xlsx (in-memory, not committed)',
      xlsxParser,
      buffer,
    );
    observations.push(outcome);
    const failure: unknown = await xlsxParser.parse(buffer).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Few, large, highly repetitive cells stay under the cell cap and land on the worksheet-byte
    // budget this fixture is shaped to reach. Repetitive filler compresses several hundred to one
    // because that is what repetition is, not because the archive is a bomb, so what refuses it
    // is the declared byte total — again a capacity limit, again with actionable guidance.
    expect(outcome.result).toBe('threw');
    expect(failure).toBeInstanceOf(MalformedXlsxException);
    expect(failure).not.toBeInstanceOf(HostileArchiveException);
    expect(outcome.detail).toContain('MalformedXlsxException');
    expect(outcome.detail).toContain('worksheet data declares more than');
    expect(outcome.detail).toContain('split the workbook or trim it to a smaller extract');
  }, 120_000);

  it('the accounting-negative sheet parses, and every number format renders the figure a reader sees', async () => {
    const buffer = await readFixture('accounting-negative.xlsx');
    const outcome = await observe('accounting-negative.xlsx', xlsxParser, buffer);
    observations.push(outcome);

    const parsed = await xlsxParser.parse(buffer);
    const cellText = (address: string): string | undefined =>
      parsed.elements.find(
        (element) => element.locator.kind === 'xlsx-cell' && element.locator.cell === address,
      )?.text;

    // Two-section format (`#,##0.00;(#,##0.00)`): the negative section is applied verbatim and its
    // parentheses are the sign, so no minus is added on top of them.
    expect(cellText('B3')).toBe('(3,200.50)');
    // Zero takes the positive section, because a two-section format declares no zero section.
    expect(cellText('B4')).toBe('0.00');

    // The genuine four-section Excel Accounting format (positive;negative;zero;text), the shape a
    // spreadsheet application writes from its number-format gallery. Its padding (`_`) and fill
    // (`*`) tokens align a column and contribute no text of their own, its negative section
    // carries a literal minus, and its zero section renders a lone dash.
    expect(cellText('C2')).toBe('12,500.00');
    expect(cellText('C3')).toBe('-3,200.50');
    expect(cellText('C4')).toBe('-');
    // Every format in the sheet is one the parser reproduces, so no cell falls back to its
    // unformatted value and nothing is flagged.
    expect(parsed.reducedFidelityReasons).toBeUndefined();
  });

  it('a Windows-1252 CSV decodes and reports the detected encoding as reduced fidelity', async () => {
    const buffer = await readFixture('windows-1252-export.csv');
    const outcome = await observe('windows-1252-export.csv', csvParser, buffer);
    observations.push(outcome);

    const parsed = await csvParser.parse(buffer);
    expect(parsed.reducedFidelityReasons?.some((reason) => reason.includes('windows-1252'))).toBe(
      true,
    );
    expect(parsed.elements.map((element) => element.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('Café Meridian')]),
    );
  });

  it('a UTF-16LE (BOM) export decodes and reports the detected encoding as reduced fidelity', async () => {
    const buffer = await readFixture('utf16-export.csv');
    const outcome = await observe('utf16-export.csv', csvParser, buffer);
    observations.push(outcome);

    const parsed = await csvParser.parse(buffer);
    // A BOM records what the author's tool intended, not what the bytes are, and UTF-16 admits no
    // validity test that could confirm it — almost every even-length buffer decodes. So a declared
    // UTF-16 export carries the same operator-visible flag as the BOM-less windows-1252 case
    // above, not a quieter one; only utf-8 goes unflagged, and only because a strict decode
    // accepted every byte.
    expect(parsed.reducedFidelityReasons ?? []).toEqual([
      'Source decoded as utf-16le; unlike utf-8, this encoding cannot be confirmed from the bytes, so some characters may differ from the source',
    ]);
    expect(parsed.elements.map((element) => element.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('Meridian Facilities Group')]),
    );
  });

  it('a semicolon-delimited CSV sniffs the delimiter and parses cleanly', async () => {
    const buffer = await readFixture('semicolon-export.csv');
    const outcome = await observe('semicolon-export.csv', csvParser, buffer);
    observations.push(outcome);

    const parsed = await csvParser.parse(buffer);
    expect(parsed.elements.map((element) => element.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('Suite')]),
    );
  });

  it('the duplicate pair parses identically (parser-level; dedupe itself is sources.service.ts territory)', async () => {
    const a = await readFixture('duplicates/folder-a/rent-roll-summary.pdf');
    const b = await readFixture('duplicates/folder-b/rent-roll-summary.pdf');
    expect(a.equals(b)).toBe(true);

    const outcome = await observe('duplicates/folder-a/rent-roll-summary.pdf', pdfParser, a);
    observations.push(outcome);
    expect(outcome.result).toBe('parsed');
  });

  it('a bidi-override paragraph parses as ordinary text — the override survives byte-for-byte', async () => {
    const buffer = await readFixture('bidi-override.docx');
    const outcome = await observe('bidi-override.docx', docxParser, buffer);
    observations.push(outcome);

    const parsed = await docxParser.parse(buffer);
    const paragraphText = parsed.elements.map((element) => element.text).join('\n');
    // The parser does not strip, flag, or normalize bidi control characters — they pass through
    // as ordinary code points. Whether a downstream consumer (the claim-alignment gate) is
    // resilient to that is out of this spec's read-only reach; recorded as a finding, not a pass.
    expect(paragraphText).toContain('‮');
    expect(paragraphText).toContain('‬');
  });

  it('a two-column PDF extracts text in write order and flags the layout as reduced fidelity', async () => {
    const buffer = await readFixture('two-column.pdf');
    const outcome = await observe('two-column.pdf', pdfParser, buffer);
    observations.push(outcome);

    const parsed = await pdfParser.parse(buffer);
    const combined = parsed.elements.map((element) => element.text).join('\n');
    const leftIndex = combined.indexOf('Left column');
    const rightIndex = combined.indexOf('Right column');
    expect(leftIndex).toBeGreaterThanOrEqual(0);
    expect(rightIndex).toBeGreaterThan(leftIndex);
    // Already handled, not a gap: the parser detects the multi-column shape on its own and names
    // the interleaving risk explicitly, rather than presenting interleaved text with no signal.
    expect(parsed.reducedFidelityReasons ?? []).toEqual([
      expect.stringContaining('likely multi-column layout'),
    ]);
  });

  it('a mixed scanned/text PDF: the page footer is itself extractable text, so the "scanned" page is not actually text-free', async () => {
    const buffer = await readFixture('mixed-scanned-text.pdf');
    const outcome = await observe('mixed-scanned-text.pdf', pdfParser, buffer);
    observations.push(outcome);

    const parsed = await pdfParser.parse(buffer);
    // FINDING about this fixture, not the parser: both pages produce an element. `pdf-helpers.ts`'s
    // shared `addFooter()` writes a "Page X of Y" text run on every page, including the one this
    // fixture built with no other `doc.text()` call — so the footer alone is enough extractable
    // text to keep the "scanned" page from being genuinely text-free. A real scanned page (no
    // pdfkit-authored footer at all) would still land in the text-free case the two-element result
    // here does not actually exercise.
    expect(parsed.elements.length).toBe(2);
    expect(
      parsed.elements
        .map((element) => element.locator)
        .map((l) => (l.kind === 'pdf-page' ? l.page : undefined)),
    ).toEqual([1, 2]);
    expect(parsed.reducedFidelityReasons ?? []).toEqual([]);
  });

  it('a truncated PDF fails as a malformed file, not silently as an empty one', async () => {
    const buffer = await readFixture('truncated.pdf');
    const outcome = await observe('truncated.pdf', pdfParser, buffer);
    observations.push(outcome);

    expect(outcome.result).toBe('threw');
    expect(
      outcome.detail.includes(new MalformedPdfException('').constructor.name) ||
        outcome.detail.includes(new EmptyPdfTextLayerException('').constructor.name),
    ).toBe(true);
  });

  it('a real PDF saved under a .txt filename is a sources.service.ts-layer rejection, not a parser one', async () => {
    // `disguised-pdf.txt` is genuine PDF bytes. `DocumentParser.parse` is dispatched by MIME, never
    // called on a `txt`-declared file with PDF content — `contentMatchesDeclaredKind`
    // (`documents.constant.ts`) is what actually rejects this shape, at the upload gate, before any
    // parser runs. Confirmed here structurally: feeding these bytes to `PdfParser` (the format they
    // really are) parses cleanly, proving the rejection is about the declared/actual kind mismatch,
    // not about the bytes being unparseable.
    const buffer = await readFixture('disguised-pdf.txt');
    const outcome = await observe(
      'disguised-pdf.txt (parsed as if it were the pdf it is)',
      pdfParser,
      buffer,
    );
    observations.push(outcome);
    expect(outcome.result).toBe('parsed');
  });

  it('an encrypted-DOCX / legacy-doc / legacy-xls CFB stub fails as a malformed/hostile archive, never silently', async () => {
    for (const fixture of ['encrypted.docx', 'legacy-memo.doc', 'legacy-ledger.xls']) {
      const buffer = await readFixture(fixture);
      const outcome = await observe(fixture, docxParser, buffer);
      observations.push(outcome);
      expect(outcome.result).toBe('threw');
      expect(outcome.detail).not.toContain(new HostileArchiveException('').constructor.name);
    }
  });

  it('a two-row-header sheet parses every data cell — header-row selection is a downstream concern', async () => {
    const buffer = await readFixture('two-row-header.xlsx');
    const outcome = await observe('two-row-header.xlsx', xlsxParser, buffer);
    observations.push(outcome);

    const parsed = await xlsxParser.parse(buffer);
    expect(parsed.elements.map((element) => element.text)).toEqual(
      expect.arrayContaining(['Aldercrest Consulting', 'Suite Detail', 'Suite']),
    );
  });

  // Inside `HTML_MAX_NESTING_DEPTH`, so this parses: the bound sits above the depth real filings
  // reach, and refusal past it is exercised in memory by `html.parser.spec.ts` rather than by a
  // committed fixture over half a megabyte. What this fixture still proves is that the walk is
  // iterative — a recursive one overflows the stack an order of magnitude shallower than this.
  it('a paragraph nested 5,000 <div> deep parses through an iterative walk', async () => {
    const buffer = await readFixture('nested-tags.html');
    const outcome = await observe('nested-tags.html', htmlParser, buffer);
    observations.push(outcome);

    expect(outcome.result).toBe('parsed');
    const parsed = await htmlParser.parse(buffer);
    expect(parsed.elements.map((element) => element.text)).toContain(
      'Deeply nested paragraph text.',
    );
  });

  it('never-closed <li> items and a trailing never-closed <p> still recover into one block each', async () => {
    const buffer = await readFixture('unclosed-tags.html');
    const outcome = await observe('unclosed-tags.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    expect(parsed.elements.map((element) => element.text)).toEqual([
      'Suite A-100 — $1,200/mo',
      'Suite A-101 — $1,450/mo',
      'Suite A-102 — $1,600/mo',
      'Figures above are unaudited.',
    ]);
  });

  it('an unterminated <script> refuses before it can swallow the rest of the document', async () => {
    const buffer = await readFixture('unterminated-script.html');
    const outcome = await observe('unterminated-script.html', htmlParser, buffer);
    observations.push(outcome);

    expect(outcome.result).toBe('threw');
    await expect(htmlParser.parse(buffer)).rejects.toBeInstanceOf(MalformedHtmlException);
  });

  it('named, decimal, and hex entities decode, and a literal </evidence> is re-escaped', async () => {
    const buffer = await readFixture('entities.html');
    const outcome = await observe('entities.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    // Built from code points rather than typed as a literal: the &nbsp; token decodes to U+00A0,
    // which is visually indistinguishable from the ordinary spaces around it.
    const expectedEntities = ['&', '<', '>', '"', "'", "'", ' ', 'é', '€'].join(' ');
    expect(parsed.elements[0]?.text).toBe(expectedEntities);
    expect(parsed.elements[1]?.text).toContain('&lt;/evidence');
    for (const element of parsed.elements) {
      expect(element.text).not.toMatch(/<\/?evidence/i);
    }
  });

  it('a well-formed 3x3 table drops the script/style inside its cells and excludes the hidden row', async () => {
    const buffer = await readFixture('script-inside-table.html');
    const outcome = await observe('script-inside-table.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    expect(findCellElement(parsed, 'HTML-TABLE-1', 'A2')?.text).toBe('A-100');
    expect(findCellElement(parsed, 'HTML-TABLE-1', 'A3')?.text).toBe('A-101');
    const allText = parsed.elements.map((element) => element.text).join('\n');
    expect(allText).not.toContain('trackView');
    expect(allText).not.toContain('color: red');
    expect(allText).not.toContain('INTERNAL');
  });

  it('every hidden-element signal is dropped, leaving only the visible paragraph', async () => {
    const buffer = await readFixture('hidden-elements.html');
    const outcome = await observe('hidden-elements.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    expect(parsed.elements.map((element) => element.text)).toEqual([
      'Visible ledger summary for Kestrel Point.',
    ]);
  });

  it("a well-formed rent-roll table flattens to cells and drops the caption's colspan along with it", async () => {
    const buffer = await readFixture('well-formed-table.html');
    const outcome = await observe('well-formed-table.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    expect(findCellElement(parsed, 'HTML-TABLE-1', 'A1')?.text).toBe('Suite');
    expect(findCellElement(parsed, 'HTML-TABLE-1', 'B2')?.text).toBe('Aldercrest Consulting');
    expect(findCellElement(parsed, 'HTML-TABLE-1', 'C6')?.text).toBe('0');
    expect(parsed.elements.some((element) => element.text.includes('Rent Roll'))).toBe(false);
    expect(parsed.reducedFidelityReasons).toBeUndefined();
  });

  it('a ragged table with an uneven width and a rowspan falls back to row text, not cells', async () => {
    const buffer = await readFixture('ragged-table.html');
    const outcome = await observe('ragged-table.html', htmlParser, buffer);
    observations.push(outcome);

    const parsed = await htmlParser.parse(buffer);
    expect(parsed.elements.some((element) => element.locator.kind === 'xlsx-cell')).toBe(false);
    expect(parsed.elements.map((element) => element.text)).toEqual([
      'Suite A-100\t1,200',
      'Occupied\tQ3 2026',
      'Suite A-101',
    ]);
    expect(parsed.reducedFidelityReasons).toEqual([
      expect.stringContaining('html-table-1-not-flattened'),
    ]);
  });

  it('a document exactly at HTML_MAX_BYTES parses', async () => {
    const buffer = buildTwentyMebibyteHtml();
    expect(buffer.length).toBe(HTML_MAX_BYTES);
    const outcome = await observe(
      'adversarial/twenty-mebibyte.html (in-memory, not committed)',
      htmlParser,
      buffer,
    );
    observations.push(outcome);

    expect(outcome.result).toBe('parsed');
    const parsed = await htmlParser.parse(buffer);
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.elements.length).toBeLessThanOrEqual(2_000);
  }, 120_000);

  it('a document one byte over HTML_MAX_BYTES refuses, naming the cap', async () => {
    const buffer = buildOversizeHtml();
    expect(buffer.length).toBe(HTML_MAX_BYTES + 1);
    const outcome = await observe(
      'adversarial/oversize.html (in-memory, not committed)',
      htmlParser,
      buffer,
    );
    observations.push(outcome);

    expect(outcome.result).toBe('threw');
    await expect(htmlParser.parse(buffer)).rejects.toBeInstanceOf(MalformedHtmlException);
    await expect(htmlParser.parse(buffer)).rejects.toThrow(new RegExp(`${HTML_MAX_BYTES}`));
  });
});

/**
 * The email container class, swept rather than sampled.
 *
 * A test per attachment type would say nothing about the property that matters here: an email is a
 * container of attacker-chosen parts, and every dimension along which one can be built — how many
 * parts, how deeply nested, how large a part decodes to, what a part claims to be versus what its
 * bytes are, what a part is named, and the degenerate empty and single-part shapes — must reach a
 * bounded outcome that an operator can see. The cases below are that set of dimensions, each
 * asserting which of the three terminal outcomes it reaches: refused (a named exception), unwrapped
 * (a stated attachment/body count), or skipped-visibly (a recorded reason).
 */
describe('email container-class sweep', () => {
  const readEmail = (name: string): Promise<Buffer> => readFixture(name);

  describe('refusals — a message that cannot be read, or that asks for more than the limits allow', () => {
    it('refuses a truncated message whose closing boundary never arrives', async () => {
      const buffer = await readEmail('email-truncated.eml');
      expect(() => parseEmailMessage(buffer)).toThrow(MalformedEmailException);
      // Terminal and visible, never zero documents reported as a success.
      expect(() => parseEmailMessage(buffer)).toThrow(/never closes it/);
    });

    it('refuses bytes with no header block at all', async () => {
      const buffer = await readEmail('email-headerless.eml');
      expect(() => parseEmailMessage(buffer)).toThrow(MalformedEmailException);
    });

    it('refuses a multipart part that declares no boundary', () => {
      const buffer = Buffer.from(
        ['From: a@b.example', 'Content-Type: multipart/mixed', '', 'body'].join('\r\n'),
        'utf8',
      );
      expect(() => parseEmailMessage(buffer)).toThrow(MalformedEmailException);
    });

    it('refuses more attachments than the part limit allows', () => {
      const buffer = buildManyAttachmentEmail(EMAIL_CONTAINER_LIMITS.maxParts + 5);
      expect(() => parseEmailMessage(buffer)).toThrow(HostileEmailException);
      expect(() => parseEmailMessage(buffer)).toThrow(/parts, exceeding the/);
    });

    it('refuses multipart nesting deeper than the depth limit', () => {
      const buffer = buildDeeplyNestedEmail(EMAIL_CONTAINER_LIMITS.maxDepth + 2);
      expect(() => parseEmailMessage(buffer)).toThrow(HostileEmailException);
      expect(() => parseEmailMessage(buffer)).toThrow(/nest/);
    });

    it('refuses a message carrying another message as an attachment', async () => {
      const buffer = await readEmail('email-nested-message.eml');
      expect(() => parseEmailMessage(buffer)).toThrow(HostileEmailException);
    });

    it('refuses one attachment that decodes past the per-attachment ceiling', () => {
      const buffer = buildOversizeAttachmentEmail(EMAIL_CONTAINER_LIMITS.maxAttachmentBytes + 1);
      expect(() => parseEmailMessage(buffer)).toThrow(HostileEmailException);
    }, 120_000);

    it('refuses attachments that are individually acceptable and collectively past the total ceiling', () => {
      const half = Math.ceil(EMAIL_CONTAINER_LIMITS.maxTotalAttachmentBytes / 2) + 1;
      const buffer = buildOversizeTotalEmail(2, half);
      expect(() => parseEmailMessage(buffer)).toThrow(HostileEmailException);
    }, 120_000);

    it('bounds an email no more loosely than a direct upload of the same bytes', () => {
      // An attachment must never be a way to get more past the gate than uploading the same file
      // would, and the sum of what one email expands into must not exceed one upload's worth
      // either — the container's own 50MB cap is a cap on encoded bytes, not on what they unwrap to.
      expect(EMAIL_CONTAINER_LIMITS.maxAttachmentBytes).toBeLessThanOrEqual(MAX_FILE_SIZE_BYTES);
      expect(EMAIL_CONTAINER_LIMITS.maxTotalAttachmentBytes).toBeLessThanOrEqual(
        MAX_FILE_SIZE_BYTES,
      );
    });
  });

  describe('unwrapped — the shapes that produce documents', () => {
    it('unwraps an honest message into its body and one attachment, carrying the envelope', async () => {
      const parsed = parseEmailMessage(await readEmail('email-with-xlsx-attachment.eml'));

      expect(parsed.attachments).toHaveLength(1);
      expect(parsed.attachments[0].filename).toBe('kestrel-point-comps.xlsx');
      expect(parsed.bodyParts.length).toBeGreaterThan(0);
      expect(parsed.bodyParts[0].toString('utf8')).toContain('Kestrel Point');
      expect(parsed.envelope.messageId).toBe('kestrel-point-q3-2026@meridian-facilities.example');
      expect(parsed.envelope.from).toContain('dana.okonkwo@meridian-facilities.example');
      expect(parsed.envelope.sentAt?.toISOString()).toBe('2026-08-04T09:14:00.000Z');
    });

    it('the unwrapped attachment is still a real spreadsheet the existing parser reads', async () => {
      const parsed = parseEmailMessage(await readEmail('email-with-xlsx-attachment.eml'));
      const attachment = parsed.attachments[0];

      // The whole point of the locator contract surviving the container: this is the same
      // `XlsxParser`, producing the same `xlsx-cell` coordinates, as an uploaded workbook.
      const sheet = await xlsxParser.parse(attachment.content);
      expect(sheet.elements.every((element) => element.locator.kind === 'xlsx-cell')).toBe(true);
      expect(sheet.elements.map((element) => element.text)).toEqual(
        expect.arrayContaining(['Aldercrest Consulting']),
      );
    });

    it('a single-part message yields a body and no attachments', async () => {
      const parsed = parseEmailMessage(await readEmail('email-single-part.eml'));
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.bodyParts).toHaveLength(1);
    });

    it('a message with an empty body reaches a stated empty result, not an error', async () => {
      const parsed = parseEmailMessage(await readEmail('email-empty-body.eml'));
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.bodyParts.map((part) => part.toString('utf8').trim())).toEqual(['']);
    });
  });

  describe('identity — what a part claims versus what its bytes are', () => {
    it('holds a disguised attachment to the same content sniff a direct upload faces', async () => {
      const parsed = parseEmailMessage(await readEmail('email-disguised-attachment.eml'));
      const attachment = parsed.attachments[0];

      // The message says spreadsheet, twice — the declared MIME and the filename agree with each
      // other and disagree with the bytes. `resolveUploadKind` believes both, exactly as it would
      // for a browser upload, and `contentMatchesDeclaredKind` is what refuses it either way.
      const kind = resolveUploadKind(attachment.declaredMimeType, attachment.filename);
      expect(kind).toBe('xlsx');
      expect(contentMatchesDeclaredKind(attachment.content, 'xlsx')).toBe(false);
    });

    it('strips a traversal out of an attachment filename without collapsing it to nothing', async () => {
      const parsed = parseEmailMessage(await readEmail('email-hostile-filename.eml'));
      const filename = parsed.attachments[0].filename;

      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
      expect(filename).not.toContain('..');
      // Still resolvable as the CSV it is: sanitizing the name must not cost the extension the
      // upload gate reads.
      expect(resolveUploadKind('text/csv', filename)).toBe('csv');
    });

    it('truncates an absurdly long filename while keeping the extension the gate reads', () => {
      const buffer = buildMultipartEmail('Long name', 'body', [
        {
          filename: `${'a'.repeat(5000)}.csv`,
          mimeType: 'text/csv',
          content: Buffer.from('a,b\r\n1,2\r\n'),
        },
      ]);

      const parsed = parseEmailMessage(buffer);
      expect(parsed.attachments[0].filename.length).toBeLessThanOrEqual(200);
      expect(resolveUploadKind('text/csv', parsed.attachments[0].filename)).toBe('csv');
    });

    it('keeps two identically-named attachments distinct rather than collapsing them', () => {
      // Filenames are sender-chosen and carry no uniqueness guarantee, so identity is the part
      // ordinal, not the name — otherwise one attachment could displace another by claiming its
      // name, and the second document would never exist.
      const buffer = buildMultipartEmail('Two exports', 'body', [
        { filename: 'export.csv', mimeType: 'text/csv', content: Buffer.from('a,b\r\n1,2\r\n') },
        { filename: 'export.csv', mimeType: 'text/csv', content: Buffer.from('c,d\r\n3,4\r\n') },
      ]);

      const parsed = parseEmailMessage(buffer);
      expect(parsed.attachments.map((attachment) => attachment.partIndex)).toEqual([0, 1]);
      expect(parsed.attachments[0].content.equals(parsed.attachments[1].content)).toBe(false);
    });
  });

  describe('skipped visibly — honest parts this product has no parser for', () => {
    it('records a reason for an HTML-only message rather than rejecting it or going quiet', async () => {
      const parsed = parseEmailMessage(await readEmail('email-html-only.eml'));
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.bodyParts).toHaveLength(0);
      expect(parsed.skippedPartReasons).toEqual([expect.stringContaining('text/html')]);
    });

    it('records a reason for an attachment whose transfer encoding it cannot decode', () => {
      const buffer = Buffer.from(
        [
          'From: a@b.example',
          'Content-Type: text/csv; name="export.csv"',
          'Content-Transfer-Encoding: x-uuencode',
          '',
          'begin 644 export.csv',
          '',
        ].join('\r\n'),
        'utf8',
      );
      const parsed = parseEmailMessage(buffer);
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.skippedPartReasons).toEqual([expect.stringContaining('x-uuencode')]);
    });

    it('records a reason for an attachment with no usable filename', () => {
      const boundary = 'b1';
      const buffer = Buffer.from(
        [
          'From: a@b.example',
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: application/octet-stream',
          'Content-Disposition: attachment',
          '',
          'opaque',
          `--${boundary}--`,
          '',
        ].join('\r\n'),
        'utf8',
      );
      const parsed = parseEmailMessage(buffer);
      expect(parsed.attachments).toHaveLength(0);
      expect(parsed.skippedPartReasons).toEqual([expect.stringContaining('no usable filename')]);
    });
  });
});
