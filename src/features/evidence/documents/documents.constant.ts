import type { DocumentSourceKind } from '../../../database/schemas/evidence/document/document.schema';

// The exact-match half of the input gate: a MIME here is trusted outright by `resolveUploadKind`.
// Also serves as the reverse lookup `getVersionContent` uses to derive a download extension from a
// stored object's `contentType` — safe because every stored `contentType` is already the canonical
// MIME `resolveUploadKind` resolved to, never the browser's raw value (see `DocumentsService.upload`).
export const MIME_TYPE_TO_SOURCE_KIND: Readonly<Record<string, DocumentSourceKind>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/markdown': 'md',
  'message/rfc822': 'eml',
  'text/html': 'html',
};

// The canonical MIME stored on a document/version for each kind — the inverse of
// `MIME_TYPE_TO_SOURCE_KIND`, plus `txt`: `text/plain` is never an exact-match key (it's always in
// `AMBIGUOUS_UPLOAD_MIME_TYPES` below) but `txt` still needs a canonical MIME once resolved by
// extension.
export const SOURCE_KIND_TO_MIME_TYPE: Readonly<Record<DocumentSourceKind, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  eml: 'message/rfc822',
  html: 'text/html',
};

// MIME types a browser/OS is known to misreport for at least one format this project accepts.
// Windows reporting a `.csv` as this exact `vnd.ms-excel` string is the load-bearing case — it
// collides with the legacy `.xls` binary this project deliberately does not support, so it cannot
// be trusted without the extension. `text/plain` is in this set unconditionally, not only "when it
// disagrees with the extension": a sniffer that got `text/plain` right for a `.txt` file and one
// that got it wrong for a `.csv`/`.md`/`.tsv` file are indistinguishable from the MIME alone, and
// both resolve identically through `UPLOAD_EXTENSION_ALLOWLIST` below (`.txt` included).
export const AMBIGUOUS_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
  '',
]);

// Extension allowlist consulted only for a MIME in `AMBIGUOUS_UPLOAD_MIME_TYPES` — never for one
// that already resolved through `MIME_TYPE_TO_SOURCE_KIND`. Deliberately closed to exactly the
// ten kinds this project supports; `.xls` is NOT here, so `application/vnd.ms-excel` + `.xls`
// fails CLOSED instead of being guessed as a spreadsheet, and `.msg` is not here either — Outlook's
// CFB-container mail format has no parser, and an allowlist entry with no parser is an upload the
// gate accepts and the ingest can only fail on.
//
// This is also the whole of what the sync path resolves with (`SourcesService.syncOneFile` calls
// `resolveUploadKind('', filename)`), so a filesystem connector decides `.eml` by extension alone
// while a browser upload can also present `message/rfc822`. The two agree on the resolved kind and
// disagree on nothing else, because `contentMatchesDeclaredKind` re-checks the bytes on both paths.
export const UPLOAD_EXTENSION_ALLOWLIST: ReadonlyMap<string, DocumentSourceKind> = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['xlsx', 'xlsx'],
  ['pptx', 'pptx'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['txt', 'txt'],
  ['md', 'md'],
  ['eml', 'eml'],
  ['html', 'html'],
  ['htm', 'html'],
]);

// No dot, a dot with nothing after it ("report."), and no extension at all all collapse to
// `undefined` here — every one of them is "no usable extension" from the ambiguous-MIME resolver's
// point of view, not three separate cases.
function extractLowercaseExtension(filename: string): string | undefined {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
    return undefined;
  }
  return filename.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Resolves an upload's `DocumentSourceKind` from what the client sent. An unambiguous MIME
 * (`MIME_TYPE_TO_SOURCE_KIND`) is trusted outright; an ambiguous one (`AMBIGUOUS_UPLOAD_MIME_TYPES`)
 * is resolved strictly by `UPLOAD_EXTENSION_ALLOWLIST`; anything else — a MIME on neither list, or
 * an ambiguous MIME with no allowlisted extension — fails CLOSED (`undefined`), never guessed. This
 * is what rejects `application/vnd.ms-excel` + `.xls`: the MIME is ambiguous and `.xls` is not on
 * the allowlist, so treating it as a spreadsheet — silently ingesting a legacy binary as text —
 * never happens.
 */
export function resolveUploadKind(
  mimetype: string,
  originalname: string,
): DocumentSourceKind | undefined {
  const normalizedMimeType = mimetype.toLowerCase();

  const exactMatch = MIME_TYPE_TO_SOURCE_KIND[normalizedMimeType];
  if (exactMatch) {
    return exactMatch;
  }

  if (!AMBIGUOUS_UPLOAD_MIME_TYPES.has(normalizedMimeType)) {
    return undefined;
  }

  const extension = extractLowercaseExtension(originalname);
  return extension ? UPLOAD_EXTENSION_ALLOWLIST.get(extension) : undefined;
}

// The family a magic-byte signature narrows content to — coarser than `DocumentSourceKind`, since
// PDF has one signature but every ZIP-container format (docx/xlsx/pptx) shares the same one and
// cannot be told apart without unzipping and inspecting parts, which this gate does not do.
// `undefined` means "no known binary signature recognized" — the honest answer for every plain-text
// format (txt/md/csv/tsv), none of which has magic bytes of its own.
type SniffedContentFamily = 'pdf' | 'zip';

const PDF_MAGIC_BYTES = Buffer.from('%PDF-', 'ascii');
// Every signature a ZIP container (the shared format under docx/xlsx/pptx) can legally start with:
// a normal local file header, an empty archive, and a spanned/split archive's first segment.
const ZIP_MAGIC_BYTE_SEQUENCES: readonly Buffer[] = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];

function sniffContentFamily(buffer: Buffer): SniffedContentFamily | undefined {
  if (buffer.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES)) {
    return 'pdf';
  }
  if (
    ZIP_MAGIC_BYTE_SEQUENCES.some((signature) =>
      buffer.subarray(0, signature.length).equals(signature),
    )
  ) {
    return 'zip';
  }
  return undefined;
}

// The family each binary `DocumentSourceKind` must sniff to. A kind absent here
// (csv/tsv/txt/md/eml/html) carries no signature of its own — an RFC 5322 message is header text
// and an HTML document is markup text, so `eml` and `html` belong with the text kinds and a ZIP or
// PDF renamed to either extension is refused for showing a binary signature.
// `contentMatchesDeclaredKind` treats "no signature recognized" as the passing case for those,
// since a plain-text format can only ever be contradicted by a binary signature it can never
// legitimately produce, not positively confirmed by one.
const SOURCE_KIND_TO_CONTENT_FAMILY: Partial<Record<DocumentSourceKind, SniffedContentFamily>> = {
  pdf: 'pdf',
  docx: 'zip',
  xlsx: 'zip',
  pptx: 'zip',
};

/**
 * Confirms an upload's bytes actually look like what `resolveUploadKind` resolved from its
 * declared MIME/filename — the content-sniffing half of the input gate, closing the gap where a
 * MIME and extension can lie about the whole file (a PDF named `report.txt` sent as `text/plain`
 * resolves to `txt` here and would otherwise ingest as mojibake under a canonical MIME that
 * launders the lie downstream).
 *
 * Fails CLOSED: a declared binary kind (pdf/docx/xlsx/pptx) must show its family's own magic
 * bytes, and a declared text kind (txt/md/csv/tsv) must show no recognized binary signature at
 * all. This is necessarily asymmetric — a signature can prove a file IS a PDF or a ZIP container,
 * but no signature can prove a file genuinely IS plain text, only that it is not something this
 * gate recognizes as one of the binary formats it must not be.
 */
export function contentMatchesDeclaredKind(
  buffer: Buffer,
  sourceKind: DocumentSourceKind,
): boolean {
  const expectedFamily = SOURCE_KIND_TO_CONTENT_FAMILY[sourceKind];
  const actualFamily = sniffContentFamily(buffer);
  return expectedFamily ? actualFamily === expectedFamily : actualFamily === undefined;
}

// Data-room artifacts observed so far are well under this; set generously above that rather
// than tied to any single fixture size.
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// Matches DataRoomPage's poll interval (`web/src/pages/DataRoomPage.tsx`'s POLL_INTERVAL_MS) —
// see `qa.constant.ts`'s identical reasoning for why this backs `DocumentsService.streamList` at
// the same cadence.
export const DOCUMENTS_STREAM_INTERVAL_MS = 3000;
