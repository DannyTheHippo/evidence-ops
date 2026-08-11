/**
 * Heuristic screen for document text that reads as an instruction aimed at whatever model reads
 * it, rather than as the record's own content — "ignore all prior instructions", "you must now
 * ...", a request to reveal a "system prompt", or an imperative to export/send/email bulk data.
 * `sanitizeEvidenceText` (this directory) neutralizes the evidence *fence* a document could try to
 * break out of; this looks at the *content* inside it, before that content ever becomes a
 * retrievable, embeddable `EvidenceChunk`.
 *
 * This is a heuristic, not a defense: it raises an attacker's cost, it does not make prompt
 * injection impossible. It only recognizes the specific imperative-at-the-reader phrasing coded
 * below — a paraphrase, a non-English translation, a base64/rot13-style encoding, or a genuinely
 * novel imperative shape all pass through untouched. It sits alongside the fence-escape
 * neutralization in `sanitize-evidence-text.ts`, the deterministic citation verifier, and the
 * canary fixtures that exercise both (`docs/adr/0004-grounding-gate-and-citation-contract.md`) —
 * no single layer here is the defense.
 *
 * Tuned for precision over recall: a real valuation memo or lease abstract can legitimately use
 * the words "must" or "instruction" in an ordinary third-person business sentence, and
 * quarantining a chunk of real evidence is worse than missing an injection the grounding gate
 * could still only ever *cite*, never execute (ADR-0004's citation-verifier-not-reasoning-verifier
 * bound). Every pattern below requires the specific second-person-imperative shape an ordinary
 * business document does not produce — never a bare keyword.
 *
 * Failure direction: this predicate is the detector half of a fail-CLOSED gate
 * (`IngestionService.ingestVersion` is the enforcement half). Phrasing this function does not
 * recognize returns `false` — that is the deliberate boundary the precision-tuned patterns draw,
 * not a hedge to be loosened casually later. Once a pattern *does* match, the caller treats the
 * element as unconditionally unsafe to index: dropped before chunking, never embedded, never
 * retrievable, never citable. Untrusted input gets the conservative outcome on a hit; the
 * conservative outcome on a miss is silence, which is exactly why this is one layer among several
 * and never described as sufficient on its own.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // "ignore/disregard [all/any/the] [prior/previous/above] instructions", and the bare
  // "disregard the above" shape that has no trailing noun at all.
  /\b(?:ignore|disregard)\b(?:\s+\w+){0,3}?\s+(?:instructions?|the\s+above)\b/i,
  // A command addressed to "you" the model, not to a human reader of the document — "you must
  // now ...", or "you are now in <x> mode".
  /\byou\s+(?:must|are\s+to|will)\s+now\b/i,
  /\byou\s+are\s+now\s+in\s+[\w-]+(?:[- ][\w-]+)*\s+mode\b/i,
  /\bsystem\s+prompt\b/i,
  // "export/send/email the [full/complete/entire/underlying] <bulk-data noun>" — an exfiltration
  // imperative, not a business instruction to a counterparty.
  /\b(?:export|send|email)\s+(?:the\s+)?(?:full\s+|complete\s+|entire\s+|underlying\s+)*(?:deal[- ]room|contents|documents?|database|system\s+prompt)\b/i,
];

/** True when `text` matches one of the imperative-at-the-model shapes above. See this module's
 * doc comment for what a `true`/`false` result does and does not prove. */
export function screenInstructionInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
