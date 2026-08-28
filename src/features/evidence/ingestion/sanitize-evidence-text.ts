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

// Every C0 control except tab/LF/CR, plus DEL and every C1 control — code points a renderer treats
// as invisible or as a raw escape, never as document content. Tab/LF/CR survive: they are the
// paragraph/line structure a chunk's own block splitting is built from.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Every Unicode format character (`\p{Cf}`): zero-width space/joiner/non-joiner, a byte-order-mark
// code point appearing mid-string rather than as a stripped BOM, soft hyphen, and every explicit
// bidi control — LRE/RLE/PDF/LRO/RLO, the LRI/RLI/FSI/PDI isolates, LRM/RLM, ALM. All of these can
// make what a viewer sees differ from the bytes verified at upload: a bidi override reorders the
// glyphs on screen, and a zero-width character hides itself entirely.
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/gu;

/**
 * Neutralizes evidence text for the boundary where it is shown to a human or handed to a model —
 * never applied at parse time, and never called from a parser. `ParsedElement.text`'s own contract
 * is that the prompt builder and the grounding gate's quote-containment check compare against the
 * exact bytes stored at parse time; running this earlier would make a stored citation diverge from
 * what a model actually cites, the same failure this codebase's own `checkQuoteAlignment`
 * (`qa/check-quote-alignment.ts`) avoids by keeping its comparison-only canonicalization out of
 * `locateQuote`'s verbatim path.
 *
 * Strips control characters and every Unicode format character (including every bidi-override and
 * zero-width code point), then NFC-normalizes — canonical composition only, never NFKC's
 * compatibility folding, which would visibly alter evidence (a ligature or full-width digit
 * rendering as a different character than the source document actually shows).
 */
export function neutralizeForDisplay(text: string): string {
  return text
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(FORMAT_CHARACTER_PATTERN, '')
    .normalize('NFC');
}
