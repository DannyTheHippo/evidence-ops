import type { DocumentSourceClass, DocumentVersionIngestionStatus } from '../../api/client';
import type { BadgeTone } from '../../components/ui/Badge';

/** The tone a version's or document's `ingestionStatus` renders with, shared by `DocumentDetail`,
 * `VersionRow` and `DocumentList`. `pending` carries the same `'info'` tone as the upload queue's
 * `uploading` row, since both describe work in progress rather than a fault. `'needs-ocr'` and
 * `'facts-failed'` carry `'caution'`: a scanned PDF with no text layer is a gap in the corpus to
 * flag for attention, and a `'facts-failed'` version has real, citable chunks and only lacks
 * extracted facts. Neither is the verification-grade failure `'rejected'` signals elsewhere in
 * this app. A total map rather than a fallthrough, so a status added to the API's union fails
 * typecheck here instead of silently inheriting a tone nobody chose for it. */
export const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'info',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};

/** Display text for `ingestionStatus`, in the filter's own order. Shared so `DocumentList`,
 * `DocumentDetail` and `DocumentWorkbenchPage` never diverge on the wording for the same status. */
export const INGESTION_LABEL: Record<DocumentVersionIngestionStatus, string> = {
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  'needs-ocr': 'Needs OCR',
  'facts-failed': 'No facts extracted',
};

/** Display text for `sourceClass`, total over all six values including `'unclassified'` — the
 * default an uploader gets by leaving the field unset. `SOURCE_CLASS_OPTIONS` in `DocumentList`
 * deliberately omits that option from the picker; this map still needs to render it once a
 * document carries it. */
export const SOURCE_CLASS_LABEL: Record<DocumentSourceClass, string> = {
  'crm-export': 'CRM export',
  'pm-export': 'PM export',
  spreadsheet: 'Spreadsheet',
  memo: 'Memo',
  report: 'Report',
  unclassified: 'Unclassified',
};
