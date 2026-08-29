import type { DocumentVersionIngestionStatus } from '../../api/client';
import type { BadgeTone } from '../../components/ui/Badge';

/** The tone a version's or document's `ingestionStatus` renders with, shared by `DocumentDetail`,
 * `VersionRow` and `DocumentList`. `'needs-ocr'` and `'facts-failed'` carry the same `'caution'`
 * tone as `'pending'`, each deliberately: a scanned PDF with no text layer is a gap in the corpus
 * to flag for attention, and a `'facts-failed'` version has real, citable chunks and only lacks
 * extracted facts. Neither is the verification-grade failure `'rejected'` signals elsewhere in
 * this app. A total map rather than a fallthrough, so a status added to the API's union fails
 * typecheck here instead of silently inheriting a tone nobody chose for it. */
export const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'caution',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};
