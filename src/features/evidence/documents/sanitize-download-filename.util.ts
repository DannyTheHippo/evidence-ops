const FALLBACK_TITLE = 'document';
const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * A document title is user-controlled free text; a `Content-Disposition` filename sits inside an
 * HTTP header, a different parsing context. Interpolating the raw title would let a quote,
 * semicolon, or newline in the title break out of the `filename="..."` value or inject a second
 * header directive — so every character outside the safe set is replaced 1:1 with `_` rather than
 * stripped, keeping the sanitized name recognizable instead of collapsing distinct titles
 * together. An empty or whitespace-only title falls back to a fixed name so the result is never a
 * bare `-vN.ext`.
 */
export function sanitizeDownloadFilename(
  title: string,
  versionNumber: number,
  extension: string,
): string {
  const sanitizedTitle = title.trim().replace(UNSAFE_CHARS, '_');
  const base = sanitizedTitle.length > 0 ? sanitizedTitle : FALLBACK_TITLE;

  return `${base}-v${versionNumber}.${extension}`;
}
