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
// eight kinds this project supports; `.xls` is NOT here, so `application/vnd.ms-excel` + `.xls`
// fails CLOSED instead of being guessed as a spreadsheet.
export const UPLOAD_EXTENSION_ALLOWLIST: ReadonlyMap<string, DocumentSourceKind> = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['xlsx', 'xlsx'],
  ['pptx', 'pptx'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['txt', 'txt'],
  ['md', 'md'],
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

// Data-room artifacts observed so far are well under this; set generously above that rather
// than tied to any single fixture size.
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// Matches DataRoomPage's poll interval (`web/src/pages/DataRoomPage.tsx`'s POLL_INTERVAL_MS) —
// see `qa.constant.ts`'s identical reasoning for why this backs `DocumentsService.streamList` at
// the same cadence.
export const DOCUMENTS_STREAM_INTERVAL_MS = 3000;
