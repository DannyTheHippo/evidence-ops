import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  harvestParentheticalAliases,
  MAX_HARVESTED_QUOTE_CHARACTERS,
  type HarvestedAliasDefinition,
} from '../../../../src/features/evidence/facts/harvest-parenthetical-aliases';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';

const LOCATOR: EvidenceLocator = { kind: 'pdf-page', page: 4, extractorVersion: 'v1' };

const element = (text: string): ParsedElement => ({ text, locator: LOCATOR, headingPath: [] });

const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const names = (definition: HarvestedAliasDefinition): string[] =>
  definition.subjectCandidates.map((candidate) => candidate.name);

/** The four pairs a defined term may be delimited by, named so a failing case reports which pair
 *  produced it rather than an opaque quote character. */
const QUOTE_PAIRS = [
  { name: 'straight double', open: '"', close: '"' },
  { name: 'straight single', open: "'", close: "'" },
  { name: 'curly double', open: '“', close: '”' },
  { name: 'curly single', open: '‘', close: '’' },
] as const;

/** Where the definite article sits relative to the quotes — all three occur in real documents and
 *  all three define the same term. */
const ARTICLE_PLACEMENTS = [
  {
    name: 'absent',
    build: (open: string, close: string, _gap: string) => `${open}Property${close}`,
  },
  {
    name: 'outside the quotes',
    build: (open: string, close: string, gap: string) => `the${gap}${open}Property${close}`,
  },
  {
    name: 'inside the quotes',
    build: (open: string, close: string, gap: string) => `${open}the${gap}Property${close}`,
  },
] as const;

/** A definition is routinely broken across a hard line wrap by the PDF text layer; the wrap must
 *  not change what is harvested. */
const GAPS = [
  { name: 'space', value: ' ' },
  { name: 'line break', value: '\n' },
  { name: 'wrapped and indented', value: '\n   ' },
] as const;

const SUBJECT = 'Northgate Business Park';
const LEAD_IN = `The asset described in this report is ${SUBJECT}`;

/**
 * Parentheticals that are not definitions. Registering an alias from any of these merges two
 * different entities' facts into one conflict group tenant-wide, so this list is the direction the
 * extractor must never fail in — it is swept against every subject shape below, not sampled.
 */
const NON_DEFINITIONS = [
  '(see Schedule 3)',
  '(as amended)',
  '($276.10 per square foot)',
  '(6.10%)',
  '(2025)',
  '(the Property)',
  '(the property)',
  '("as amended")',
  '("see Schedule 3")',
  '("2025 Purchase Agreement")',
  '("$276.10")',
  '("")',
  '("   ")',
  '(" ")',
  '("Property" and "Improvements")',
  '("Property", "Improvements")',
  '(collectively, the "Properties")',
  '(each, a "Party")',
  '(together with the "Improvements")',
  '(the "Property" (as defined below))',
  '((the "Property"))',
  '(the "Property" as defined in Section 2)',
  '(hereinafter the "Property")',
  '("the market rate for comparable industrial space in the region during calendar 2025")',
  '("A B C D E F")',
  '("Borrower’s")',
  "('Borrower's')",
  '("Property”)',
  '(“Property")',
] as const;

/** Every mismatched open/close combination across the four pairs. A quote the author did not close
 *  with the character they opened it with is not a delimited term. */
const MISMATCHED_QUOTES = QUOTE_PAIRS.flatMap((openPair) =>
  QUOTE_PAIRS.filter((closePair) => closePair.close !== openPair.close).map(
    (closePair) => `(the ${openPair.open}Property${closePair.close})`,
  ),
);

/** Parentheses the author never balanced. Neither an unterminated group nor a stray closer has a
 *  readable span, so neither may yield a definition. */
const UNBALANCED_PARENTHESES = [
  `${LEAD_IN} (the "Property".`,
  `${LEAD_IN} (the "Property"`,
  `${LEAD_IN} the "Property").`,
  `${LEAD_IN} the "Property")`,
  `${LEAD_IN} ((the "Property".`,
  `${LEAD_IN} )(the "Property"`,
] as const;

describe('harvestParentheticalAliases', () => {
  describe('the definition grammar, swept', () => {
    for (const pair of QUOTE_PAIRS) {
      for (const placement of ARTICLE_PLACEMENTS) {
        for (const gap of GAPS) {
          const parenthetical = `(${placement.build(pair.open, pair.close, gap.value)})`;
          const text = `${LEAD_IN} ${parenthetical}.`;

          it(`reads ${pair.name} quotes with the article ${placement.name}, separated by a ${gap.name}`, () => {
            const [definition, ...rest] = harvestParentheticalAliases([element(text)]);

            expect(rest).toEqual([]);
            expect(definition.aliases[0]).toBe('Property');
            expect(names(definition)).toContain(SUBJECT);
            expect(definition.locator).toEqual(LOCATOR);

            for (const candidate of definition.subjectCandidates) {
              expect(text).toContain(candidate.quote);
              expect(collapse(candidate.quote).startsWith(candidate.name)).toBe(true);
              expect(candidate.quote.endsWith(')')).toBe(true);
            }
          });

          it(`licenses the article form only when the definition carries one — ${pair.name}, article ${placement.name}, ${gap.name}`, () => {
            const [definition] = harvestParentheticalAliases([element(text)]);

            expect(definition.aliases).toEqual(
              placement.name === 'absent' ? ['Property'] : ['Property', 'the Property'],
            );
          });
        }
      }
    }

    it('collapses a term broken across a line wrap to the same alias as an unwrapped one', () => {
      const wrapped = harvestParentheticalAliases([
        element(`${LEAD_IN} (the "Long\n   Term Lease").`),
      ]);
      const unwrapped = harvestParentheticalAliases([
        element(`${LEAD_IN} (the "Long Term Lease").`),
      ]);

      expect(wrapped[0].aliases).toEqual(['Long Term Lease', 'the Long Term Lease']);
      expect(wrapped[0].aliases).toEqual(unwrapped[0].aliases);
    });

    it('reads every definition in a sentence, each attributed to its own antecedent', () => {
      const text = `${SUBJECT} (the "Property") was sold by Acme Holdings ("Seller") to Beta Trust ("Buyer") in March 2025.`;

      const definitions = harvestParentheticalAliases([element(text)]);

      expect(definitions.map((definition) => definition.aliases[0])).toEqual([
        'Property',
        'Seller',
        'Buyer',
      ]);
      expect(names(definitions[1])).toContain('Acme Holdings');
      expect(names(definitions[2])).toContain('Beta Trust');
    });

    it('offers suffixes of the antecedent longest first, so the registry picks the boundary', () => {
      const [definition] = harvestParentheticalAliases([
        element(`located at ${SUBJECT} (the "Property").`),
      ]);

      expect(names(definition)[0]).toBe(`located at ${SUBJECT}`);
      expect(names(definition)).toEqual([
        'located at Northgate Business Park',
        'at Northgate Business Park',
        'Northgate Business Park',
        'Business Park',
        'Park',
      ]);
    });

    /**
     * The citation belongs to the candidate, not to the definition: the registry attributes the
     * alias to whichever suffix it matches, and an operator judging the proposal must read a quote
     * whose leading text is that same suffix. One quote per definition, cut at the longest
     * candidate, would show `located at …` for an alias attributed to `Northgate Business Park`.
     */
    it('cuts each candidate its own quote, starting at that candidate', () => {
      const [definition] = harvestParentheticalAliases([
        element(`located at ${SUBJECT} (the "Property").`),
      ]);

      expect(definition.subjectCandidates.map((candidate) => candidate.quote)).toEqual([
        'located at Northgate Business Park (the "Property")',
        'at Northgate Business Park (the "Property")',
        'Northgate Business Park (the "Property")',
        'Business Park (the "Property")',
        'Park (the "Property")',
      ]);
    });

    it('keeps an antecedent inside the sentence that contains the definition', () => {
      const [definition] = harvestParentheticalAliases([
        element(`Acme Holdings owns nothing here. ${SUBJECT} (the "Property") is the asset.`),
      ]);

      expect(names(definition)[0]).toBe(SUBJECT);
    });

    it('does not treat an abbreviation period as the end of the antecedent', () => {
      const [definition] = harvestParentheticalAliases([
        element(`The borrower is Acme Holdings, Inc. ("Borrower").`),
      ]);

      expect(names(definition)).toContain('Acme Holdings, Inc.');
    });

    it('is deterministic — the same elements yield the same definitions', () => {
      const elements = [element(`${LEAD_IN} (the "Property").`)];

      expect(harvestParentheticalAliases(elements)).toEqual(harvestParentheticalAliases(elements));
    });
  });

  /**
   * The lookahead in {@link buildSubjectCandidates}'s sentence-end pattern accepts exactly two
   * Unicode categories after a period — Lu (uppercase letter) and Nd (decimal digit) — so this
   * sweep pairs members of each with a near neighbour that reads as digit- or letter-like without
   * belonging to either category the pattern actually tests: a lowercase letter is Ll, not Lu; a
   * Roman numeral is Nl, not Nd; a superscript digit is No, not Nd; a titlecase letter is Lt, not
   * Lu. Multiple scripts per accepted category prove the sweep exercises the category itself
   * rather than one code point that happens to satisfy it.
   */
  describe('the sentence-boundary lookahead, swept across what visibly starts the next sentence', () => {
    const VISIBLE_SENTENCE_START = [
      { name: 'ASCII uppercase letter', char: 'W', cutsHere: true },
      { name: 'Latin-1 uppercase letter', char: 'É', cutsHere: true },
      { name: 'Greek uppercase letter', char: 'Σ', cutsHere: true },
      { name: 'Cyrillic uppercase letter', char: 'Ж', cutsHere: true },
      { name: 'ASCII digit', char: '5', cutsHere: true },
      { name: 'Arabic-Indic digit', char: '٥', cutsHere: true },
      { name: 'fullwidth digit', char: '５', cutsHere: true },
      { name: 'lowercase letter (Ll, not Lu)', char: 'w', cutsHere: false },
      { name: 'Roman numeral (Nl, not Nd)', char: 'Ⅴ', cutsHere: false },
      { name: 'superscript digit (No, not Nd)', char: '⁵', cutsHere: false },
      { name: 'titlecase letter (Lt, not Lu)', char: 'ǅ', cutsHere: false },
    ] as const;

    for (const member of VISIBLE_SENTENCE_START) {
      it(`${member.cutsHere ? 'cuts' : 'does not cut'} the antecedent at a period before a ${member.name}`, () => {
        const [definition] = harvestParentheticalAliases([
          element(`Acme Holdings owns nothing here. ${member.char}X (the "Term").`),
        ]);

        expect(names(definition)[0]).toBe(
          member.cutsHere ? `${member.char}X` : `Acme Holdings owns nothing here. ${member.char}X`,
        );
      });
    }

    /**
     * The pattern's terminator position accepts exactly three characters — a period, an
     * exclamation mark and a question mark — but every case above, and every other case in this
     * file, terminates its lead-in sentence with a period. Swept exhaustively — the class is small
     * and fully enumerable — so each terminator is proven to cut on its own rather than assumed
     * from the period's behaviour.
     */
    const SENTENCE_TERMINATOR = [
      { name: 'period', char: '.' },
      { name: 'exclamation mark', char: '!' },
      { name: 'question mark', char: '?' },
    ] as const;

    for (const terminator of SENTENCE_TERMINATOR) {
      it(`cuts the antecedent at a ${terminator.name} before a visible sentence start`, () => {
        const [definition] = harvestParentheticalAliases([
          element(`Acme Holdings owns nothing here${terminator.char} WX (the "Term").`),
        ]);

        expect(names(definition)[0]).toBe('WX');
      });
    }

    /**
     * The pattern requires one or more whitespace characters between the terminator and the
     * visible sentence start, but every case above places exactly one space there, which cannot
     * distinguish "one or more" from "zero or more". A terminator directly followed by a capital
     * letter, with nothing between them, is the one shape where those two quantifiers disagree.
     */
    it('does not cut the antecedent at a period with no whitespace before the next sentence', () => {
      const [definition] = harvestParentheticalAliases([
        element('Acme Holdings owns nothing here.WX (the "Term").'),
      ]);

      expect(names(definition)[0]).toBe('Acme Holdings owns nothing here.WX');
    });
  });

  describe('parentheticals that define nothing', () => {
    for (const parenthetical of NON_DEFINITIONS) {
      it(`registers no alias for ${parenthetical}`, () => {
        expect(harvestParentheticalAliases([element(`${LEAD_IN} ${parenthetical}.`)])).toEqual([]);
      });
    }

    for (const text of MISMATCHED_QUOTES) {
      it(`registers no alias for a mismatched quote pair in ${text}`, () => {
        expect(harvestParentheticalAliases([element(`${LEAD_IN} ${text}.`)])).toEqual([]);
      });
    }

    for (const text of UNBALANCED_PARENTHESES) {
      it(`registers no alias for unbalanced parentheses in ${JSON.stringify(text)}`, () => {
        expect(harvestParentheticalAliases([element(text)])).toEqual([]);
      });
    }

    it('registers no alias for a definition with no antecedent in its element', () => {
      expect(harvestParentheticalAliases([element('(the "Property") is the asset.')])).toEqual([]);
    });

    it('registers no alias across an element boundary', () => {
      expect(
        harvestParentheticalAliases([element(SUBJECT), element('(the "Property") is the asset.')]),
      ).toEqual([]);
    });

    it('registers no alias for an empty corpus', () => {
      expect(harvestParentheticalAliases([])).toEqual([]);
      expect(harvestParentheticalAliases([element('')])).toEqual([]);
    });
  });

  /**
   * Holds over the whole corpus above — positives, negatives and hostile shapes together — so a
   * later change cannot buy a new positive by inventing text the document does not contain. Every
   * harvested alias, subject candidate and quote is text the author actually wrote.
   */
  describe('every harvested definition is grounded in the element it came from', () => {
    const corpus = [
      ...QUOTE_PAIRS.flatMap((pair) =>
        ARTICLE_PLACEMENTS.flatMap((placement) =>
          GAPS.map(
            (gap) =>
              `${LEAD_IN} (${placement.build(pair.open, pair.close, gap.value)}) trades well.`,
          ),
        ),
      ),
      ...NON_DEFINITIONS.map((parenthetical) => `${LEAD_IN} ${parenthetical}.`),
      ...MISMATCHED_QUOTES.map((text) => `${LEAD_IN} ${text}.`),
      ...UNBALANCED_PARENTHESES,
      `${SUBJECT} (the "Property") was sold by Acme Holdings ("Seller").`,
      '(the "Property") is the asset.',
      '',
    ];

    for (const text of corpus) {
      it(`grounds every definition read from ${JSON.stringify(text)}`, () => {
        const collapsedText = collapse(text);

        for (const definition of harvestParentheticalAliases([element(text)])) {
          expect(definition.aliases.length).toBeGreaterThan(0);
          expect(definition.subjectCandidates.length).toBeGreaterThan(0);

          for (const alias of definition.aliases) {
            expect(alias).toMatch(/\p{L}/u);
            expect(alias).toBe(collapse(alias));
            expect(collapsedText).toContain(collapse(alias.replace(/^the /u, '')));
          }

          for (const candidate of definition.subjectCandidates) {
            expect(candidate.name).toBe(collapse(candidate.name));
            expect(collapsedText).toContain(candidate.name);
            expect(text).toContain(candidate.quote);
            expect(candidate.quote.length).toBeLessThanOrEqual(MAX_HARVESTED_QUOTE_CHARACTERS);
          }
        }
      });
    }
  });

  /**
   * The output this function returns is persisted and read back on every question, so what it
   * costs to produce matters as much as what it produces. Every case here is a shape a real
   * document can carry unremarkably — a DOCX paragraph joins its runs with no separator
   * (`docx.parser.ts`), so alignment padding, an em-dash rule, or Word's own NBSP land as an
   * interior run between two ordinary words, and a repeated footer or header is the most ordinary
   * way a document produces many identical definitions in one element.
   */
  describe('the extraction terminates in bounded time regardless of input shape', () => {
    /**
     * Every code point the character class between an antecedent's words treats specially:
     * comma, hyphen-minus, every hyphen/dash variant U+2010 through U+2015, the Unicode minus
     * sign, and every code point `\s` matches under the `u` flag. Swept exhaustively — it is
     * small and fully enumerable — rather than sampled, because the cost this axis can trigger
     * does not depend on which member fills the run.
     */
    const INTERIOR_RUN_CLASS_MEMBERS = [
      { name: 'comma', char: ',' },
      { name: 'hyphen-minus', char: '-' },
      { name: 'U+2010 hyphen', char: '\u2010' },
      { name: 'U+2011 non-breaking hyphen', char: '\u2011' },
      { name: 'U+2012 figure dash', char: '\u2012' },
      { name: 'U+2013 en dash', char: '\u2013' },
      { name: 'U+2014 em dash', char: '\u2014' },
      { name: 'U+2015 horizontal bar', char: '\u2015' },
      { name: 'U+2212 minus sign', char: '\u2212' },
      { name: 'tab', char: '\t' },
      { name: 'line feed', char: '\n' },
      { name: 'vertical tab', char: '\v' },
      { name: 'form feed', char: '\f' },
      { name: 'carriage return', char: '\r' },
      { name: 'space', char: ' ' },
      { name: 'non-breaking space', char: '\u00a0' },
      { name: 'ogham space mark', char: '\u1680' },
      { name: 'en quad', char: '\u2000' },
      { name: 'em quad', char: '\u2001' },
      { name: 'en space', char: '\u2002' },
      { name: 'em space', char: '\u2003' },
      { name: 'three-per-em space', char: '\u2004' },
      { name: 'four-per-em space', char: '\u2005' },
      { name: 'six-per-em space', char: '\u2006' },
      { name: 'figure space', char: '\u2007' },
      { name: 'punctuation space', char: '\u2008' },
      { name: 'thin space', char: '\u2009' },
      { name: 'hair space', char: '\u200a' },
      { name: 'line separator', char: '\u2028' },
      { name: 'paragraph separator', char: '\u2029' },
      { name: 'narrow no-break space', char: '\u202f' },
      { name: 'medium mathematical space', char: '\u205f' },
      { name: 'ideographic space', char: '\u3000' },
      { name: 'zero width no-break space (BOM)', char: '\ufeff' },
    ] as const;

    /** Ordinary word characters, offered as the linear baseline every class member is judged
     *  against — the run they fill is the same length, so only the character class differs. */
    const NON_CLASS_CONTROLS = [
      { name: 'letter', char: 'z' },
      { name: 'digit', char: '5' },
      { name: 'period', char: '.' },
    ] as const;

    const RUN_LENGTH = 15000;
    const COST_BUDGET_MS = 250;

    // A run this shape and length is un-terminated by any structural boundary or the end of the
    // string — the antecedent word "Corp" follows it directly — so it is exactly the shape that
    // makes an unanchored `[class]+$` trim retry every start position in the run.
    const textWithInteriorRun = (char: string): string =>
      `Acme${char.repeat(RUN_LENGTH)}Corp("Ab").`;

    beforeAll(() => {
      // Warms the JIT so the first measured case is not penalised by cold compilation.
      harvestParentheticalAliases([element(textWithInteriorRun('z'))]);
    });

    for (const member of [...INTERIOR_RUN_CLASS_MEMBERS, ...NON_CLASS_CONTROLS]) {
      it(`stays under ${COST_BUDGET_MS}ms for a ${RUN_LENGTH}-character interior run of ${member.name}`, () => {
        const start = Date.now();
        harvestParentheticalAliases([element(textWithInteriorRun(member.char))]);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(COST_BUDGET_MS);
      });
    }

    describe('definition density in one element', () => {
      const DEFINITION_COUNT = 4000;
      const DENSITY_COST_BUDGET_MS = 600;

      it(`stays under ${DENSITY_COST_BUDGET_MS}ms for ${DEFINITION_COUNT} repeated definitions in one element`, () => {
        // The same definition repeated verbatim is the most ordinary way a document produces many
        // definitions in one element — a running footer or header printed on every page.
        const text = 'Acme ("Ab") '.repeat(DEFINITION_COUNT);

        const start = Date.now();
        const definitions = harvestParentheticalAliases([element(text)]);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(DENSITY_COST_BUDGET_MS);
        expect(definitions.length).toBe(DEFINITION_COUNT);
      });
    });
  });

  /**
   * `MAX_TERM_WORDS`, `MAX_TERM_CHARACTERS`, `MAX_SUBJECT_WORDS` and
   * `MAX_HARVESTED_QUOTE_CHARACTERS` bound the module's output; a cap that is never actually
   * reached in a test is a cap the suite cannot tell has been deleted. Each case below sits
   * exactly at, one below, or one above the limit it exercises, isolated so it does not also cross
   * a different cap.
   */
  describe('bound-reaching inputs flip accept to refuse exactly at the declared cap', () => {
    const wordsOfLength = (count: number): string =>
      Array.from({ length: count }, (_, index) => String.fromCharCode(65 + (index % 26))).join(' ');

    const TERM_WORD_COUNTS = [
      { count: 4, accepted: true },
      { count: 5, accepted: true },
      { count: 6, accepted: false },
    ] as const;

    for (const { count, accepted } of TERM_WORD_COUNTS) {
      it(`a ${count}-word defined term is ${accepted ? 'harvested' : 'refused'} — MAX_TERM_WORDS`, () => {
        const definitions = harvestParentheticalAliases([
          element(`${LEAD_IN} ("${wordsOfLength(count)}").`),
        ]);

        expect(definitions.length > 0).toBe(accepted);
      });
    }

    const TERM_CHARACTER_COUNTS = [
      { length: 63, accepted: true },
      { length: 64, accepted: true },
      { length: 65, accepted: false },
    ] as const;

    for (const { length, accepted } of TERM_CHARACTER_COUNTS) {
      it(`a ${length}-character defined term is ${accepted ? 'harvested' : 'refused'} — MAX_TERM_CHARACTERS`, () => {
        const term = 'A' + 'a'.repeat(length - 1);
        const definitions = harvestParentheticalAliases([element(`${LEAD_IN} ("${term}").`)]);

        expect(definitions.length > 0).toBe(accepted);
      });
    }

    const SUBJECT_WORD_COUNTS = [7, 8, 9] as const;

    for (const wordCount of SUBJECT_WORD_COUNTS) {
      it(`offers at most 8 subject candidates for a ${wordCount}-word antecedent — MAX_SUBJECT_WORDS`, () => {
        const antecedent = Array.from({ length: wordCount }, (_, index) => `Word${index}`).join(
          ' ',
        );
        const [definition] = harvestParentheticalAliases([
          element(`${antecedent} (the "Property").`),
        ]);

        expect(definition.subjectCandidates.length).toBe(Math.min(wordCount, 8));
      });
    }

    const QUOTE_LENGTH_CASES = [
      { wordLength: 633, expectedQuoteLength: 639, accepted: true },
      { wordLength: 634, expectedQuoteLength: 640, accepted: true },
      { wordLength: 635, expectedQuoteLength: 641, accepted: false },
    ] as const;

    for (const { wordLength, expectedQuoteLength, accepted } of QUOTE_LENGTH_CASES) {
      it(`a ${expectedQuoteLength}-character quote is ${accepted ? 'kept' : 'dropped'} — MAX_HARVESTED_QUOTE_CHARACTERS`, () => {
        const antecedent = 'X'.repeat(wordLength);
        const definitions = harvestParentheticalAliases([element(`${antecedent}("Ab").`)]);

        if (accepted) {
          expect(definitions[0].subjectCandidates[0].quote.length).toBe(expectedQuoteLength);
        } else {
          expect(definitions).toEqual([]);
        }
      });
    }
  });

  /** The module copies `locator` through unchanged; it never branches on which kind it is. Swept
   *  across every kind `EvidenceLocator` declares so a future branch cannot single one out. */
  describe('the locator on a harvested definition matches the element it came from', () => {
    const LOCATORS: readonly EvidenceLocator[] = [
      { kind: 'pdf-page', page: 4, extractorVersion: 'v1' },
      { kind: 'docx-paragraph', paragraphIndex: 2, headingPath: [], extractorVersion: 'v1' },
      { kind: 'xlsx-region', sheetName: 'Sheet1', range: 'A1:B2', extractorVersion: 'v1' },
      { kind: 'xlsx-cell', sheetName: 'Sheet1', cell: 'A1', extractorVersion: 'v1' },
      { kind: 'text-block', blockIndex: 0, headingPath: [], extractorVersion: 'v1' },
      { kind: 'pptx-slide', slide: 1, extractorVersion: 'v1' },
    ];

    for (const locator of LOCATORS) {
      it(`carries a ${locator.kind} locator through unchanged`, () => {
        const [definition] = harvestParentheticalAliases([
          { text: `${LEAD_IN} (the "Property").`, locator, headingPath: [] },
        ]);

        expect(definition.locator).toEqual(locator);
      });
    }
  });
});
