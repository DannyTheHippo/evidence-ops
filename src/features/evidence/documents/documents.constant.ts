import type { DocumentSourceKind } from '../../../database/schemas/evidence/document/document.schema';

// One map serves two purposes: it is the content-type allowlist (input gate, fails CLOSED —
// anything not a key is rejected) and it derives `sourceKind`, which correlates 1:1 with the
// mimetype per the comment on `Document.sourceKind`.
export const MIME_TYPE_TO_SOURCE_KIND: Readonly<Record<string, DocumentSourceKind>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// Data-room artifacts observed so far are well under this; set generously above that rather
// than tied to any single fixture size.
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// Matches DataRoomPage's poll interval (`web/src/pages/DataRoomPage.tsx`'s POLL_INTERVAL_MS) —
// see `qa.constant.ts`'s identical reasoning for why this backs `DocumentsService.streamList` at
// the same cadence.
export const DOCUMENTS_STREAM_INTERVAL_MS = 3000;
