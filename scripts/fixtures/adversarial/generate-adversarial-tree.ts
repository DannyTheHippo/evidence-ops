import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildAccountingNegativeSheet } from './lib/build-accounting-negative-sheet';
import { buildBidiOverrideDocx } from './lib/build-bidi-override-docx';
import { buildCfbStub } from './lib/build-cfb-stub';
import { buildDuplicatePairContent } from './lib/build-duplicate-pair';
import {
  buildDisguisedAttachmentEmail,
  buildEmailWithXlsxAttachment,
  buildEmptyBodyEmail,
  buildHeaderlessEmail,
  buildHostileFilenameEmail,
  buildHtmlOnlyEmail,
  buildNestedMessageEmail,
  buildSinglePartEmail,
  buildTruncatedEmail,
} from './lib/build-email-fixtures';
import { buildAdversarialManifest } from './lib/build-manifest';
import {
  buildEntitiesHtml,
  buildHiddenElementsHtml,
  buildNestedTagsHtml,
  buildRaggedTableHtml,
  buildScriptInsideTableHtml,
  buildUnclosedTagsHtml,
  buildUnterminatedScriptHtml,
  buildWellFormedTableHtml,
} from './lib/build-html-fixtures';
import { buildMixedScannedTextPdf } from './lib/build-mixed-scanned-text-pdf';
import { buildSemicolonCsv } from './lib/build-semicolon-csv';
import { buildTruncatedPdfSource } from './lib/build-truncated-pdf-source';
import { truncatePdf } from './lib/build-truncated-pdf';
import { buildTwoColumnPdf } from './lib/build-two-column-pdf';
import { buildTwoRowHeaderSheet } from './lib/build-two-row-header-sheet';
import { buildUtf16Export } from './lib/build-utf16-export';
import { buildWindows1252Csv } from './lib/build-windows1252-csv';

/**
 * Generates the adversarial fixture tree into `targetDir` — every condition named in this plan
 * step's own text except the in-memory-only builders (the 100k-row XLSX, the wide-cell XLSX, and
 * the two byte-cap HTML fixtures), which are deliberately never written to disk here (see
 * `lib/build-huge-xlsx.ts`'s own doc comment: each is multi-megabyte, generated fresh by whichever
 * spec needs it, and never committed). Exported as a function, mirroring `generate-data-room.ts`,
 * so both `../adversarial-cli.ts` and the determinism/property specs call the exact same code path.
 */
export async function generateAdversarialTree(targetDir: string): Promise<void> {
  await mkdir(path.join(targetDir, 'duplicates', 'folder-a'), { recursive: true });
  await mkdir(path.join(targetDir, 'duplicates', 'folder-b'), { recursive: true });

  const duplicate = await buildDuplicatePairContent();
  const windows1252Csv = buildWindows1252Csv();
  const semicolonCsv = buildSemicolonCsv();
  const utf16Export = buildUtf16Export();
  const twoRowHeaderSheet = await buildTwoRowHeaderSheet();
  const accountingNegativeSheet = await buildAccountingNegativeSheet();
  const bidiOverrideDocx = await buildBidiOverrideDocx();
  const twoColumnPdf = await buildTwoColumnPdf();
  const mixedScannedTextPdf = await buildMixedScannedTextPdf();
  const truncationSource = await buildTruncatedPdfSource();
  const truncatedPdf = truncatePdf(truncationSource.buffer);
  const encryptedDocxStub = buildCfbStub('encrypted-docx');
  const legacyDocStub = buildCfbStub('legacy-doc');
  const legacyXlsStub = buildCfbStub('legacy-xls');
  const emailWithXlsx = await buildEmailWithXlsxAttachment();
  const truncatedEmail = await buildTruncatedEmail();
  const disguisedAttachmentEmail = await buildDisguisedAttachmentEmail();
  const nestedMessageEmail = await buildNestedMessageEmail();

  const entries: Array<{ path: string; buffer: Buffer; description: string }> = [
    {
      path: 'duplicates/folder-a/rent-roll-summary.pdf',
      buffer: duplicate.buffer,
      description: 'Byte-identical to duplicates/folder-b/rent-roll-summary.pdf, different path.',
    },
    {
      path: 'duplicates/folder-b/rent-roll-summary.pdf',
      buffer: duplicate.buffer,
      description: 'Byte-identical to duplicates/folder-a/rent-roll-summary.pdf, different path.',
    },
    {
      path: 'windows-1252-export.csv',
      buffer: windows1252Csv,
      description: 'CRM-style export encoded as Windows-1252, no BOM.',
    },
    {
      path: 'semicolon-export.csv',
      buffer: semicolonCsv,
      description: 'Plain UTF-8 CSV using a semicolon field delimiter.',
    },
    {
      path: 'utf16-export.csv',
      buffer: utf16Export,
      description: "Excel 'Unicode Text' style export: UTF-16LE with a byte-order mark.",
    },
    {
      path: 'two-row-header.xlsx',
      buffer: twoRowHeaderSheet,
      description: 'A repeated category band above the real field-name header row.',
    },
    {
      path: 'accounting-negative.xlsx',
      buffer: accountingNegativeSheet,
      description:
        'Accounting-style negative (parens) and zero values under two- and four-section number formats.',
    },
    {
      path: 'bidi-override.docx',
      buffer: bidiOverrideDocx,
      description: 'A paragraph containing a U+202E/U+202C bidi override pair.',
    },
    {
      path: 'two-column.pdf',
      buffer: twoColumnPdf.buffer,
      description: 'One page laid out as two side-by-side text blocks.',
    },
    {
      path: 'mixed-scanned-text.pdf',
      buffer: mixedScannedTextPdf.buffer,
      description: 'Page 1 has extractable text; page 2 has none, standing in for a scanned page.',
    },
    {
      path: 'truncated.pdf',
      buffer: truncatedPdf,
      description: `A well-formed PDF (${truncationSource.description}) with its last 20% cut off.`,
    },
    {
      path: 'disguised-pdf.txt',
      buffer: twoColumnPdf.buffer,
      description: 'A genuine PDF, saved under a .txt filename.',
    },
    {
      path: 'encrypted.docx',
      buffer: encryptedDocxStub,
      description: 'A CFB-container stub, the byte shape real password-protected OOXML takes.',
    },
    {
      path: 'legacy-memo.doc',
      buffer: legacyDocStub,
      description: 'A CFB-container stub standing in for a legacy Word 97-2003 .doc file.',
    },
    {
      path: 'legacy-ledger.xls',
      buffer: legacyXlsStub,
      description: 'A CFB-container stub standing in for a legacy Excel 97-2003 .xls file.',
    },
    {
      path: 'email-with-xlsx-attachment.eml',
      buffer: emailWithXlsx,
      description: 'A multipart/mixed message: a plain-text body plus a real XLSX attachment.',
    },
    {
      path: 'email-truncated.eml',
      buffer: truncatedEmail,
      description:
        'The same message cut off mid-attachment, so its closing boundary never arrives.',
    },
    {
      path: 'email-headerless.eml',
      buffer: buildHeaderlessEmail(),
      description: 'Bytes with no empty line, so no header block ever closes.',
    },
    {
      path: 'email-disguised-attachment.eml',
      buffer: disguisedAttachmentEmail,
      description: 'An attachment declaring a spreadsheet MIME and .xlsx name, carrying PDF bytes.',
    },
    {
      path: 'email-hostile-filename.eml',
      buffer: buildHostileFilenameEmail(),
      description: 'A CSV attachment whose declared filename is a path traversal.',
    },
    {
      path: 'email-html-only.eml',
      buffer: buildHtmlOnlyEmail(),
      description: 'A multipart/alternative message whose only alternative is text/html.',
    },
    {
      path: 'email-single-part.eml',
      buffer: buildSinglePartEmail(),
      description: 'A message with no multipart structure: one plain-text body, no attachments.',
    },
    {
      path: 'email-empty-body.eml',
      buffer: buildEmptyBodyEmail(),
      description: 'A well-formed header block closed by an empty line, with nothing after it.',
    },
    {
      path: 'email-nested-message.eml',
      buffer: nestedMessageEmail,
      description: 'A message carrying another whole message as a message/rfc822 attachment.',
    },
    {
      path: 'nested-tags.html',
      buffer: buildNestedTagsHtml(),
      description:
        'One paragraph wrapped in 5,000 levels of nested <div> — deep enough to need an iterative walk, inside the depth bound so it parses.',
    },
    {
      path: 'unclosed-tags.html',
      buffer: buildUnclosedTagsHtml(),
      description: 'A <ul> of never-closed <li> items and a trailing never-closed <p>.',
    },
    {
      path: 'unterminated-script.html',
      buffer: buildUnterminatedScriptHtml(),
      description: 'A <script> with no closing tag, following one visible paragraph.',
    },
    {
      path: 'entities.html',
      buffer: buildEntitiesHtml(),
      description: 'Named, decimal, and hex entities, &nbsp;, and a literal &lt;/evidence&gt;.',
    },
    {
      path: 'script-inside-table.html',
      buffer: buildScriptInsideTableHtml(),
      description: 'A well-formed 3x3 table with <script>/<style> in cells and a hidden row.',
    },
    {
      path: 'hidden-elements.html',
      buffer: buildHiddenElementsHtml(),
      description: 'A visible paragraph beside every hidden-element signal the parser honours.',
    },
    {
      path: 'well-formed-table.html',
      buffer: buildWellFormedTableHtml(),
      description: 'A rent-roll style header and five data rows, with colspan on the caption only.',
    },
    {
      path: 'ragged-table.html',
      buffer: buildRaggedTableHtml(),
      description: 'A table with uneven row widths and a rowspan greater than one.',
    },
  ];

  await Promise.all(
    entries.map((entry) => writeFile(path.join(targetDir, entry.path), entry.buffer)),
  );

  const manifest = buildAdversarialManifest(entries);
  await writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
