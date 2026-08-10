/**
 * The delimiter that fences untrusted document text inside a prompt. Anthropic's guidance is to
 * wrap untrusted content in explicit tags and tell the model the contents are data, not
 * instructions; that only holds if the content cannot close the fence itself.
 *
 * Exported so the prompt builder and this sanitizer can never drift apart — a delimiter changed
 * in one place and not the other silently reopens the hole this closes.
 */
export const EVIDENCE_DELIMITER_TAG = 'evidence';

/**
 * Case-insensitive on purpose. The fence is interpreted by a language model reading text, not by
 * a strict XML parser, so `</EVIDENCE>` reads as a closing tag just as well as `</evidence>` — an
 * exact-case match would leave the obvious bypass open.
 */
const DELIMITER_PATTERN = new RegExp(`<(/?)(${EVIDENCE_DELIMITER_TAG})`, 'gi');

/**
 * Neutralizes any attempt by document text to break out of its evidence fence.
 *
 * Applied once, at parse time, so the stored chunk text is exactly what the prompt will contain
 * and exactly what the grounding gate compares a model's quote against. Escaping later — at
 * prompt assembly — would mean the model quotes escaped text while the gate checks raw text, and
 * every citation over affected content would fail verification for the wrong reason.
 *
 * For any document that does not literally contain the delimiter this is the identity function,
 * which is every non-adversarial document: stored evidence stays byte-faithful to its source in
 * the normal case, and only a document actively trying to escape the fence is altered.
 *
 * This is one layer, not the defense. Per Anthropic's own guidance no single control suffices —
 * it sits alongside the per-step tool allowlist, the deterministic citation verifier, and the
 * canary fixtures that assert injected instructions never reach an answer.
 */
export function sanitizeEvidenceText(text: string): string {
  // `$2` preserves the original casing so the escaped text still reads as what the document
  // actually said — this neutralizes the delimiter without editing the evidence.
  return text.replace(DELIMITER_PATTERN, '&lt;$1$2');
}
