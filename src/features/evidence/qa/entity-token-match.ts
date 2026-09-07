import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';

function escapeRegExpToken(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One compiled pattern per distinct needle, reused across every `containsNormalizedToken` call for
// that needle — `verifyClaim` calls it per fact x per citation, and with `subjectBinding` on that is
// a lot of repeat compiles of the same handful of entity/metric-phrase patterns. Safe to reuse
// without a `lastIndex` reset: the pattern carries no `g`/`y` flag, so `.test()` never advances any
// per-instance state.
const tokenPatternCache = new Map<string, RegExp>();

function tokenPattern(needle: string): RegExp {
  let pattern = tokenPatternCache.get(needle);
  if (!pattern) {
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExpToken(needle)}(?![\\p{L}\\p{N}])`, 'u');
    tokenPatternCache.set(needle, pattern);
  }
  return pattern;
}

/**
 * Whole-token containment between two already-{@link normalizeEntityName}d strings: `needle` must
 * occur in `haystack` with no Unicode letter/digit immediately adjacent on either side, so a short
 * or generic subject name — an attacker-controlled `factKey.entity` extracted from hostile document
 * text, or a short metric alias — cannot bind by matching inside an unrelated longer word. Also
 * exported (re-exported by `verify-claim.ts`) for `ClaimVerificationService.findProseTouchedFactKeys`,
 * which runs the same whole-token check against a claim's own statement rather than a retrieved
 * chunk's text.
 */
export function containsNormalizedToken(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return tokenPattern(needle).test(haystack);
}

/** Whether any of `subjectEntities` occurs as a whole normalized token inside `chunkText`. */
export function chunkContainsSubjectEntity(
  chunkText: string,
  subjectEntities: ReadonlySet<string>,
): boolean {
  const normalizedChunkText = normalizeEntityName(chunkText);
  return [...subjectEntities].some((entity) =>
    containsNormalizedToken(normalizedChunkText, entity),
  );
}
