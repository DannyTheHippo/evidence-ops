import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';

/**
 * One antecedent a parenthetical may be defining an alias for, paired with the citation that
 * belongs to it: the verbatim span of the element's text from this candidate's first character
 * through the closing parenthesis, character-for-character.
 *
 * One quote per candidate rather than one per definition, because the registry attributes the
 * alias to whichever candidate it matches. A single quote cut at the longest candidate would show
 * an operator leading text that is not the antecedent the alias was attributed to.
 */
export interface HarvestedAliasSubject {
  /** A suffix of the words preceding the parenthetical, whitespace-collapsed. */
  readonly name: string;
  /** The citation an operator reads to check an alias attributed to {@link name}. Never longer
   *  than {@link MAX_HARVESTED_QUOTE_CHARACTERS}. */
  readonly quote: string;
}

/**
 * One parenthetical definition read off a document — the author naming an alias for an entity they
 * just referred to, e.g. `Northgate Business Park (the "Property")`.
 *
 * `subjectCandidates` is a list, not a name, because a parenthetical's antecedent has no marked
 * left edge: the preceding run of words is ambiguous between "Northgate Business Park" and "at
 * Northgate Business Park" and "located at Northgate Business Park". Every suffix of that run is
 * offered, longest first, and the registry decides which one is an entity by exact match —
 * nothing here guesses at a boundary.
 */
export interface HarvestedAliasDefinition {
  /** Suffixes of the words preceding the parenthetical, longest first, each with its own quote. */
  readonly subjectCandidates: readonly HarvestedAliasSubject[];
  /**
   * The alias forms this definition licenses: the defined term itself, plus its `the `-prefixed
   * form when — and only when — the definition carried a definite article. Whitespace-collapsed so
   * a definition broken across a line wrap yields the same alias as an unwrapped one.
   */
  readonly aliases: readonly string[];
  readonly locator: EvidenceLocator;
}

/** Opening-to-closing quote characters that may delimit a defined term. A term must open and close
 *  with the *same* pair; a mismatched pair is a parse the author did not write, so it is refused. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
];

/** Words a defined term may span. A quoted run longer than this is a quotation the author is
 *  reproducing, not a term they are defining. */
const MAX_TERM_WORDS = 5;

/** Characters a defined term may span, bounding a run of many short words for the same reason
 *  {@link MAX_TERM_WORDS} bounds the word count. */
const MAX_TERM_CHARACTERS = 64;

/** Words offered back from the text preceding a parenthetical. Every entity name this registry
 *  holds is far shorter; a longer window only adds candidates that cannot match anything. */
const MAX_SUBJECT_WORDS = 8;

/**
 * Characters a candidate's verbatim citation may span, counted over the raw text from the
 * candidate's first character through the closing parenthesis. A candidate whose span is longer is
 * not offered at all, so no definition this function returns carries a longer quote.
 *
 * The value is the widest span the bounds above can produce plus room to round: {@link
 * MAX_SUBJECT_WORDS} words of {@link MAX_TERM_CHARACTERS} characters each, single-space separated,
 * reach 519 characters, and the parenthetical adds an article, a quote pair and a term of at most
 * {@link MAX_TERM_CHARACTERS}. Raw text longer than that is not the compact phrase a definition
 * is — it is a long unbroken run, or a whitespace run the collapse hides, standing between the
 * antecedent and the parenthesis.
 *
 * Fails CLOSED: an over-long span drops the candidate rather than clipping its quote, because a
 * clipped citation is one an operator cannot check the alias against — and dropping costs only an
 * alias the document stated in a shape no legitimate definition takes.
 */
export const MAX_HARVESTED_QUOTE_CHARACTERS = 640;

/** Characters a harvested alias may span: a defined term, plus the `the `-prefixed form this
 *  function emits alongside it when the definition carried a definite article. */
export const MAX_HARVESTED_ALIAS_CHARACTERS = MAX_TERM_CHARACTERS + 'the '.length;

/** A single character of trailing punctuation between an antecedent and the parenthetical that
 *  opens after it — tested one character at a time by {@link trimTrailingSubjectPunctuation}. */
const TRAILING_SUBJECT_PUNCTUATION_CHARACTER = /[,\-‐-―−\s]/u;

/** Leading punctuation left over when a candidate suffix starts mid-phrase. */
const LEADING_SUBJECT_PUNCTUATION = /^[\s,;:.\-‐-―−"'“”‘’]+/u;

const DEFINITE_ARTICLE = /^the\s+/iu;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * `value` with any trailing run of {@link TRAILING_SUBJECT_PUNCTUATION_CHARACTER} characters
 * removed, walked one character at a time from the end rather than matched with a `[...]+$`
 * pattern. An unanchored `+$` regex retries its match at every earlier start position when the run
 * does not reach the string's end — quadratic in the run's length — and a run of exactly that shape
 * is ordinary: a DOCX paragraph joins its runs with no separator, so alignment padding, an em-dash
 * rule, or NBSP from Word sits between two words with nothing after it but more antecedent text.
 */
function trimTrailingSubjectPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_SUBJECT_PUNCTUATION_CHARACTER.test(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Every parenthesis group in `text` that opens and closes at nesting depth zero, with the span it
 * covers. A group whose opening parenthesis is never closed is not returned at all — an
 * unterminated parenthetical has no readable end, so there is no span to quote and no content to
 * parse. A closing parenthesis with no matching opener is likewise ignored rather than treated as
 * the end of an implied group.
 */
function findTopLevelParentheticals(
  text: string,
): { readonly openIndex: number; readonly closeIndex: number; readonly inner: string }[] {
  const groups: { openIndex: number; closeIndex: number; inner: string }[] = [];
  let depth = 0;
  let openIndex = -1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '(') {
      if (depth === 0) {
        openIndex = index;
      }
      depth += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        groups.push({ openIndex, closeIndex: index, inner: text.slice(openIndex + 1, index) });
      }
    }
  }

  return groups;
}

/**
 * The term a parenthetical defines, or `null` when it defines nothing.
 *
 * Fails CLOSED — every shape that is not unambiguously a definition returns `null` — because a
 * term harvested in error is registered as an alias tenant-wide and silently merges two different
 * entities' facts into one conflict group, fabricating agreement the documents never expressed.
 * A definition missed here costs only a fact that stays in its own group, which is where it
 * already is.
 *
 * The gate is the quote pair: the whole parenthetical, article aside, must *be* a quoted term and
 * nothing else. That refuses `(see Schedule 3)`, `($276.10 per square foot)` and `(as amended)`
 * without enumerating them, and it refuses the distributive forms (`(collectively, the
 * "Properties")`, `(each, a "Party")`) whose antecedent is a list rather than the single phrase
 * preceding the parenthesis.
 */
function parseDefinedTerm(
  inner: string,
): { readonly term: string; readonly hadArticle: boolean } | null {
  let remainder = inner.trim();
  let hadArticle = false;

  const outerArticle = DEFINITE_ARTICLE.exec(remainder);
  if (outerArticle) {
    hadArticle = true;
    remainder = remainder.slice(outerArticle[0].length);
  }

  const pair = QUOTE_PAIRS.find(([open]) => remainder.startsWith(open));
  if (!pair) {
    return null;
  }

  const [open, close] = pair;
  if (!remainder.endsWith(close) || remainder.length < open.length + close.length + 1) {
    return null;
  }

  let term = collapseWhitespace(remainder.slice(open.length, remainder.length - close.length));

  const innerArticle = DEFINITE_ARTICLE.exec(term);
  if (innerArticle) {
    hadArticle = true;
    term = term.slice(innerArticle[0].length);
  }

  if (!isDefinableTerm(term)) {
    return null;
  }

  return { term, hadArticle };
}

/**
 * Whether `term` reads as a name rather than as prose. Fails CLOSED, for the reason
 * {@link parseDefinedTerm} states: every condition here is a way for a quoted run to be something
 * other than a defined term, and any one of them refuses the whole definition.
 */
function isDefinableTerm(term: string): boolean {
  if (term.length === 0 || term.length > MAX_TERM_CHARACTERS) {
    return false;
  }
  if (term.split(' ').length > MAX_TERM_WORDS) {
    return false;
  }
  // A defined term is a proper noun the author capitalises. Prose fragments, currency runs and
  // cross-references that survived the quote gate do not start with a capital letter.
  if (!/^\p{Lu}/u.test(term)) {
    return false;
  }
  // Parentheses or quote characters inside the term mean the quote pair closed somewhere other
  // than where this parse assumed, so the span is not the term the author delimited.
  if (/[()"'“”‘’]/u.test(term)) {
    return false;
  }
  return true;
}

/** A character that ends the backward scan in {@link buildSubjectCandidates} for the nearest
 *  structural boundary before a parenthetical. */
const STRUCTURAL_BOUNDARY_CHARACTER = /[;:()\n\r]/u;

/**
 * Suffixes of the words immediately preceding `openIndex`, longest first, each paired with the
 * index it starts at so the caller can cut a verbatim quote. The window stops at the nearest
 * structural boundary — a sentence end, a semicolon, a colon, a line break, or a preceding
 * parenthetical — so a candidate can never reach back across text that is not part of the phrase
 * being defined.
 */
function buildSubjectCandidates(
  text: string,
  openIndex: number,
): { readonly name: string; readonly startIndex: number }[] {
  const before = text.slice(0, openIndex);

  // Everything back to the last structural boundary character, found by scanning backward from
  // `openIndex` rather than forward from 0. A forward scan costs O(before.length) on every call,
  // and `before` grows with every earlier definition in the element, so one rescan per definition
  // makes the whole element quadratic in definition count. Scanning backward instead costs only the
  // distance to the nearest boundary — and every earlier definition's own closing parenthesis is
  // itself a boundary, so that distance stays short.
  const runStart = (() => {
    for (let index = before.length - 1; index >= 0; index--) {
      if (STRUCTURAL_BOUNDARY_CHARACTER.test(before[index])) {
        return index + 1;
      }
    }
    return 0;
  })();

  const run = before.slice(runStart);

  // A sentence end inside the run is a boundary too, but a terminator alone does not make one: a
  // period ends a sentence here only where the next sentence visibly starts, with a capital letter
  // or a digit. `Acme Holdings, Inc. ("Borrower")` therefore keeps its abbreviation, where a rule
  // keyed on the period alone would cut the antecedent away and lose the definition entirely.
  // Cutting late costs only a longer quote and extra candidates the registry will not match;
  // cutting early costs the alias.
  const sentenceEnd = /[.!?]\s+(?=[\p{Lu}\p{Nd}])/gu;
  let phraseStart = runStart;
  let sentenceMatch: RegExpExecArray | null;
  while ((sentenceMatch = sentenceEnd.exec(run)) !== null) {
    phraseStart = runStart + sentenceMatch.index + sentenceMatch[0].length;
  }

  const phrase = trimTrailingSubjectPunctuation(text.slice(phraseStart, openIndex));
  if (phrase.trim().length === 0) {
    return [];
  }

  const wordMatches = [...phrase.matchAll(/\S+/gu)];
  const window = wordMatches.slice(-MAX_SUBJECT_WORDS);

  const candidates: { name: string; startIndex: number }[] = [];
  for (const wordMatch of window) {
    const startIndex = phraseStart + (wordMatch.index ?? 0);
    const name = collapseWhitespace(
      text.slice(startIndex, phraseStart + phrase.length).replace(LEADING_SUBJECT_PUNCTUATION, ''),
    );
    if (name.length > 0) {
      candidates.push({ name, startIndex });
    }
  }

  return candidates;
}

/**
 * Reads parenthetical alias definitions out of already-parsed document text. Deterministic and
 * total: same elements in, same definitions out, no model call and no I/O of any kind — which is
 * what makes "harvesting an alias costs no inference" a property of the type rather than of a
 * mock's call count.
 *
 * Only a definition whose antecedent sits in the *same* parsed element is visible; a sentence the
 * parser split across two elements yields nothing rather than a definition attached to whatever
 * text happened to precede the parenthesis.
 */
export function harvestParentheticalAliases(
  elements: readonly ParsedElement[],
): HarvestedAliasDefinition[] {
  const definitions: HarvestedAliasDefinition[] = [];

  for (const element of elements) {
    for (const group of findTopLevelParentheticals(element.text)) {
      const parsed = parseDefinedTerm(group.inner);
      if (!parsed) {
        continue;
      }

      // Filtered on the span's length before it is cut, so an over-long candidate never
      // materialises the megabytes it would have quoted.
      const candidates = buildSubjectCandidates(element.text, group.openIndex)
        .filter(
          (candidate) =>
            group.closeIndex + 1 - candidate.startIndex <= MAX_HARVESTED_QUOTE_CHARACTERS,
        )
        .map((candidate) => ({
          name: candidate.name,
          quote: element.text.slice(candidate.startIndex, group.closeIndex + 1),
        }));
      if (candidates.length === 0) {
        continue;
      }

      definitions.push({
        subjectCandidates: candidates,
        aliases: parsed.hadArticle ? [parsed.term, `the ${parsed.term}`] : [parsed.term],
        locator: element.locator,
      });
    }
  }

  return definitions;
}
