import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';

/**
 * Corporate-suffix tokens a near-match comparison strips from the end of a name, matched after
 * punctuation has already been folded to whitespace — so "L.P." and "Inc." are matched as the
 * words "l p" and "inc" they become. Kept to the four forms the near-match sweep names plus their
 * closest common cousin, not a long allowlist: a permissive list only manufactures false-positive
 * proposals, which is the failure a review queue exists to avoid rather than commit.
 */
const CORPORATE_SUFFIX_PATTERN = /\s+(llc|inc|ltd|l\s?p|corp)$/;

/**
 * Folds `name` past what {@link normalizeEntityName} folds, for the sole purpose of finding a
 * suffix-only or punctuation-only near match — never for resolution, which stays exact and never
 * calls this. Ampersand and "and" are equated, comma/period/hyphen become whitespace, and a single
 * trailing corporate suffix is stripped.
 *
 * Two names are a near match exactly when this function returns the same non-empty string for
 * both. It never decides whether the two also differ under {@link normalizeEntityName} — a caller
 * comparing an unresolved name against the registry already knows that by construction, since an
 * exact match would have resolved and never reached this comparison at all.
 */
export function normalizeForNearMatch(name: string): string {
  const punctuationFolded = normalizeEntityName(name)
    .replace(/&/g, 'and')
    .replace(/[.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return punctuationFolded.replace(CORPORATE_SUFFIX_PATTERN, '').trim();
}
