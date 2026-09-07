import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { CanonicalEntityListing } from '../facts/canonical-entity.service';
import { findStatedPeriodSpans, type Period } from '../facts/derive-period';
import { containsNormalizedToken } from './entity-token-match';
import { extractNumericTokenMatches } from './extract-numeric-tokens';
import type { VerifierMeasure } from './types/verifier-measure.type';

/**
 * The unit family a {@link NumericAssertion} carries, read off the number's own matched text and
 * its neighbouring word tokens. `'unknown'` covers a bare quantity ("3 stories") that names no unit
 * this module recognizes — still a real number `verifyStructuredSupport` can match against an
 * unqualified fact, just with nothing narrowing which measure it belongs to.
 */
export type UnitKind = 'currency' | 'percentage' | 'area' | 'duration' | 'unknown';

/**
 * One number `parseClaimAssertions` read out of a claim statement, in both the form the statement
 * wrote it (`value`) and the form comparable to a `GroundingCellFact`'s canonical amount
 * (`canonicalValue = value * scale`) — a percentage's `4.55` canonicalizes to the ratio `0.0455`.
 * `index` is the offset into the assertion's `maskedStatement` the number was read from.
 */
export interface NumericAssertion {
  readonly value: number;
  readonly unitKind: UnitKind;
  readonly scale: number;
  readonly canonicalValue: number;
  readonly index: number;
}

/**
 * Everything `verifyStructuredSupport` needs to check one claim statement's numbers, periods and
 * subjects against a candidate `GroundingCellFact`, computed once per claim.
 *
 * The defining property: **no character inside a period span ever reaches numeric extraction.**
 * `maskedStatement` replaces every date-ish span `findStatedPeriodSpans` finds with spaces of equal
 * length before `numbers` is derived from it, so a date's own digits ("2025", "7", "15" out of
 * "2025-07-15") can never register as a claimed amount — equal-length masking is what keeps every
 * other offset in `maskedStatement` identical to the source statement's.
 */
export interface ClaimAssertions {
  readonly maskedStatement: string;
  readonly numbers: readonly NumericAssertion[];
  readonly periods: readonly Period[];
  readonly entityMentions: ReadonlySet<string>;
  readonly measureMentions: ReadonlySet<string>;
}

interface WordToken {
  readonly word: string;
  readonly index: number;
  readonly end: number;
}

function tokenizeWords(text: string): WordToken[] {
  return [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    index: match.index,
    end: match.index + match[0].length,
  }));
}

/** The nearest word token before `index` (for the "USD" check) and the two nearest after `end`
 * (for every other unit word), both read off `tokens` rather than raw character adjacency. */
function neighborWords(
  tokens: readonly WordToken[],
  index: number,
  end: number,
): { readonly preceding?: string; readonly following: readonly string[] } {
  const before = tokens.filter((token) => token.end <= index);
  const after = tokens.filter((token) => token.index >= end).slice(0, 2);
  return { preceding: before.at(-1)?.word, following: after.map((token) => token.word) };
}

const MAGNITUDE_SCALES: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  bn: 1e9,
  billion: 1e9,
};
const AREA_WORDS = new Set(['sf', 'rsf']);
const DURATION_YEAR_WORDS = new Set(['year', 'years', 'yr']);
const DURATION_MONTH_WORDS = new Set(['month', 'months']);

function isAreaPhrase(words: readonly string[]): boolean {
  return words.some(
    (word, i) =>
      AREA_WORDS.has(word) ||
      (word === 'sq' && words[i + 1] === 'ft') ||
      (word === 'square' && (words[i + 1] === 'feet' || words[i + 1] === 'foot')),
  );
}

interface UnitContext {
  readonly unitKind: UnitKind;
  readonly scale: number;
}

/**
 * Reads one numeric match's unit from its own matched text and its neighbouring word tokens —
 * never from `index - 1` alone, because `NUMERIC_TOKEN_PATTERN` admits a leading `\$?` *inside* the
 * match itself, so `$46.9 million`'s `$` is part of the matched text, not the character before it.
 * Percentage and basis-point forms are checked first because they otherwise collide with the
 * magnitude-word scale below (a bare `%`/`bps` carries no `k`/`m`/`bn` word to compete with); a
 * currency sign takes the unit kind over an area or duration word trailing the same number, which
 * is what keeps "$269.34 per square foot" reading as a dollar amount rather than an area.
 */
function classifyUnit(
  matchedText: string,
  preceding: string | undefined,
  following: readonly string[],
): UnitContext {
  const hasPercentSign = matchedText.endsWith('%');
  const hasPercentWord = following.some((word) => word === 'percent' || word === 'pct');
  if (hasPercentSign || hasPercentWord) {
    return { unitKind: 'percentage', scale: 0.01 };
  }
  const hasBps = following[0] === 'bps' || (following[0] === 'basis' && following[1] === 'points');
  if (hasBps) {
    return { unitKind: 'percentage', scale: 0.0001 };
  }

  const magnitudeScale = following.map((word) => MAGNITUDE_SCALES[word]).find(Boolean);
  const scale = magnitudeScale ?? 1;
  const isCurrency = matchedText.includes('$') || preceding === 'usd';
  if (isCurrency) {
    return { unitKind: 'currency', scale };
  }
  if (isAreaPhrase(following)) {
    return { unitKind: 'area', scale };
  }
  if (following.some((word) => DURATION_YEAR_WORDS.has(word))) {
    return { unitKind: 'duration', scale: 1 };
  }
  if (following.some((word) => DURATION_MONTH_WORDS.has(word))) {
    return { unitKind: 'duration', scale: 1 / 12 };
  }
  return { unitKind: 'unknown', scale };
}

/** `normalized` with every {@link findStatedPeriodSpans} span overwritten by spaces of the same
 * length — a plain `slice`/`repeat`/`slice` rebuild, so every offset outside a masked span stays
 * valid whether or not the source text carries characters outside the Basic Multilingual Plane. */
function maskPeriodSpans(
  normalized: string,
  spans: readonly { readonly start: number; readonly end: number }[],
): string {
  return spans.reduce(
    (text, span) =>
      text.slice(0, span.start) + ' '.repeat(span.end - span.start) + text.slice(span.end),
    normalized,
  );
}

/**
 * Parses a claim statement into the numbers, periods and named subjects `verifyStructuredSupport`
 * checks against retrieved evidence. See {@link ClaimAssertions} for the masking invariant this
 * function's `numbers` derivation depends on.
 */
export function parseClaimAssertions(input: {
  readonly statement: string;
  readonly measures: readonly VerifierMeasure[];
  readonly entities: readonly CanonicalEntityListing[];
}): ClaimAssertions {
  const normalized = input.statement.normalize('NFKC');
  const periodSpans = findStatedPeriodSpans(normalized);
  const maskedStatement = maskPeriodSpans(normalized, periodSpans);

  const periodsByKey = new Map<string, Period>();
  for (const span of periodSpans) {
    periodsByKey.set(span.period.key, span.period);
  }

  const wordTokens = tokenizeWords(maskedStatement);
  const numbers: NumericAssertion[] = extractNumericTokenMatches(maskedStatement).map((match) => {
    const matchedText = maskedStatement.slice(match.index, match.end);
    const { preceding, following } = neighborWords(wordTokens, match.index, match.end);
    const { unitKind, scale } = classifyUnit(matchedText, preceding, following);
    return {
      value: match.value,
      unitKind,
      scale,
      canonicalValue: match.value * scale,
      index: match.index,
    };
  });

  const normalizedForMentions = normalizeEntityName(normalized);
  const entityMentions = new Set<string>();
  for (const entity of input.entities) {
    const isMentioned =
      containsNormalizedToken(normalizedForMentions, entity.canonicalNameNormalized) ||
      entity.aliasesNormalized.some((alias) =>
        containsNormalizedToken(normalizedForMentions, alias),
      );
    if (isMentioned) {
      entityMentions.add(entity.canonicalNameNormalized);
    }
  }

  const measureMentions = new Set<string>();
  for (const measure of input.measures) {
    const namedForms = [measure.label, ...measure.aliases].map((phrase) =>
      normalizeEntityName(phrase),
    );
    const isMentioned = namedForms.some((phrase) =>
      containsNormalizedToken(normalizedForMentions, phrase),
    );
    if (isMentioned) {
      measureMentions.add(measure.slug);
    }
  }

  return {
    maskedStatement,
    numbers,
    periods: [...periodsByKey.values()],
    entityMentions,
    measureMentions,
  };
}
