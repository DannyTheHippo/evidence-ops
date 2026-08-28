// Cuts off the last 20% of a well-formed PDF — deep enough to always take the xref table and
// trailer with it (both live at the very end of a PDF, which is why a PDF reader seeks from EOF
// rather than parsing forward), so the result is unambiguously a corrupt file rather than a
// PDF that merely lost its last page of content.
const TRUNCATION_FRACTION = 0.2;

/** Truncates a well-formed PDF buffer to simulate a copy interrupted mid-write (a crashed sync
 *  client, a network share disconnect) — the file starts with valid PDF header bytes, so a
 *  magic-byte sniff alone cannot tell it apart from a whole one. */
export function truncatePdf(wellFormed: Buffer): Buffer {
  const keepBytes = Math.floor(wellFormed.length * (1 - TRUNCATION_FRACTION));
  return wellFormed.subarray(0, keepBytes);
}
