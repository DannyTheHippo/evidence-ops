import { normalizeForNearMatch } from '../../../../src/features/evidence/facts/near-match-entity-name';

/**
 * The class sweep 0005 requires: every entry pairs a base name against a variant that differs only
 * by a corporate suffix, punctuation, or case/whitespace — never a sampled single instance like
 * "Acme Tower" / "Acme Tower, LLC" alone, which would close only that one pair and leave the class
 * open for the next name that reaches it.
 */
const NEAR_MATCH_PAIRS: readonly (readonly [string, string, string])[] = [
  // Corporate suffixes — the four the sweep names, each with and without its trailing period, plus
  // the unabbreviated wording a document may use instead of the abbreviation.
  ['Acme Tower', 'Acme Tower, LLC', 'comma before LLC'],
  ['Acme Tower', 'Acme Tower LLC', 'LLC, no comma'],
  ['Acme Tower', 'Acme Tower Inc.', 'Inc. with period'],
  ['Acme Tower', 'Acme Tower Inc', 'Inc without period'],
  ['Acme Tower', 'Acme Tower Ltd', 'Ltd'],
  ['Acme Tower', 'Acme Tower Ltd.', 'Ltd. with period'],
  ['Acme Tower', 'Acme Tower L.P.', 'L.P. with periods'],
  ['Acme Tower', 'Acme Tower LP', 'LP without periods'],
  ['Acme Tower', 'Acme Tower Corp', 'Corp'],
  // Punctuation-only differences — comma, period, hyphen, and ampersand-versus-"and".
  ['Acme Tower', 'Acme, Tower', 'internal comma'],
  ['Acme Tower', 'Acme Tower.', 'trailing period'],
  ['Acme Tower', 'Acme-Tower', 'hyphen in place of a space'],
  ['Acme and Tower', 'Acme & Tower', 'ampersand in place of "and"'],
  // Case and whitespace variants.
  ['Acme Tower', 'ACME TOWER', 'all caps'],
  ['Acme Tower', 'acme   tower', 'collapsed internal whitespace'],
  ['Acme Tower', '  Acme Tower  ', 'leading and trailing whitespace'],
];

/**
 * The negative direction, which matters more than the positive one: two names that are not the
 * same entity, however superficially close, must never collapse to the same near-match key — a
 * comparator that proposes noise gets click-through-approved and becomes a silent merge with extra
 * steps.
 */
const NOT_NEAR_MATCH_PAIRS: readonly (readonly [string, string, string])[] = [
  ['Acme Tower', 'Acme Plaza', 'different building, same first word'],
  ['North Building', 'South Building', 'different building, same second word'],
  ['Acme Tower', 'Beacon Tower', 'different first word, same second word'],
  ['Acme Tower', 'Acme Tower Annex', 'a real qualifier, not a corporate suffix'],
];

describe('normalizeForNearMatch', () => {
  it.each(NEAR_MATCH_PAIRS)('treats %s and %s as a near match — %s', (a, b) => {
    expect(normalizeForNearMatch(a)).toBe(normalizeForNearMatch(b));
  });

  it.each(NOT_NEAR_MATCH_PAIRS)('never treats %s and %s as a near match — %s', (a, b) => {
    expect(normalizeForNearMatch(a)).not.toBe(normalizeForNearMatch(b));
  });
});
