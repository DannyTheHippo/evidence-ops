import { sanitizeEvidenceText } from '../../features/evidence/ingestion/sanitize-evidence-text';

/**
 * Collapses a label field (chunk id, locator, or any other single-line prompt header) to one line
 * and escapes the evidence tag pattern. Used for prompt header fields, never for full document or
 * chunk text — see `assembleAnswerMessages`'s module doc comment for why chunk text must not be
 * escaped a second time.
 *
 * The input is treated as attacker-controlled: a spreadsheet's own sheet name
 * (`XlsxRegionLocator`/`XlsxCellLocator.sheetName`, taken verbatim from `worksheet.name` in
 * `xlsx.parser.ts`) is never sanitized upstream, and a DOCX heading (`docx.parser.ts:132`) is
 * tag-escaped but not length- or newline-bounded — a heading can carry a soft line break. Header
 * fields are deliberately placed on their own line rather than as an `id="..."` / `locator="..."`
 * attribute specifically to remove the quote character as a structural delimiter: there is no
 * attribute-value boundary here for a label to escape out of. The remaining risk with a bare-line
 * format is a label injecting its own fake newline-delimited header line (e.g. a second
 * `chunkId: ...` line impersonating another chunk) — collapsing embedded newlines to a single
 * space closes that, so each field is provably confined to the one line it was placed on.
 */
export function formatPromptLabel(value: string): string {
  return sanitizeEvidenceText(value)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
}
