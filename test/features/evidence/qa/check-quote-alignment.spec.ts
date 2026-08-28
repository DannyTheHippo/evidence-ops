import {
  checkQuoteAlignment,
  MIN_QUOTE_CONTENT_TOKENS,
  MIN_SHARED_CONTENT_TOKENS,
  SHARED_CONTENT_TOKEN_RATIO,
} from '../../../../src/features/evidence/qa/check-quote-alignment';
import { locateQuote } from '../../../../src/shared/utils/locate-quote.util';

describe('checkQuoteAlignment', () => {
  it('should export the documented floor and ratio', () => {
    expect(MIN_QUOTE_CONTENT_TOKENS).toBe(3);
    expect(MIN_SHARED_CONTENT_TOKENS).toBe(2);
    expect(SHARED_CONTENT_TOKEN_RATIO).toBe(0.2);
  });

  it('should reject a quote below the content-token floor, even one appearing verbatim in the chunk', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was renovated last year.',
      quotes: ['the'],
    });

    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(0);
  });

  it('should reject the first quote below the floor when a claim cites more than one', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was renovated last year.',
      quotes: ['Northgate Business Park was renovated.', 'and'],
    });

    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(1);
  });

  it('should reject a substantive quote that shares nothing with the statement', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park traded in March 2025.',
      quotes: [
        'Tenant shall have the right to extend the Term for two (2) successive periods of five (5) years each.',
      ],
    });

    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should reject a claim whose only overlap with its quote is an uncorroborated shared number', () => {
    // The year-laundering case: a claim about an entirely different entity and event shares nothing
    // with its quote except a coincidental year. No `corroboratedNumericTokens` is passed, matching a
    // claim with no cell fact backing that number on the cited chunk.
    const result = checkQuoteAlignment({
      statement: 'Vantage Holdings was indicted for securities fraud in 2025.',
      quotes: ['Northgate Business Park traded in March 2025.'],
    });

    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should align a claim whose only overlap with a terse cell quote is a corroborated shared number', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park sold for $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // The statement's words (northgate, business, park, sold) share nothing with the quote's
    // (sale, price, usd) — the only overlap is the number itself. A cell locator addresses a single
    // spreadsheet cell, so a cell quote is terse by construction; the shared number aligns it only
    // because it is corroborated by a cell fact of the same value on the cited chunk.
    expect(result.kind).toBe('aligned');
  });

  it("should reject a bare-number quote below the per-quote substance floor when the number is not corroborated, even matching the statement's number exactly", () => {
    const result = checkQuoteAlignment({
      statement: 'The property sold for $41,000,000.',
      quotes: ['41000000'],
    });

    // A lone numeric token is one content token, below MIN_QUOTE_CONTENT_TOKENS (3), and with no
    // corroborated numeric token to substitute for that content, the per-quote substance floor
    // rejects the quote before the overlap step ever runs.
    expect(result.kind).toBe('quote-not-substantive');
    if (result.kind !== 'quote-not-substantive') throw new Error('unreachable');
    expect(result.quoteIndex).toBe(0);
  });

  it('should accept a bare-number quote below the per-quote substance floor when the number is corroborated', () => {
    const result = checkQuoteAlignment({
      statement: 'The property sold for $41,000,000.',
      quotes: ['41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // A terse cell quote that is only a value has no content tokens to spare, so a corroborated
    // numeric token stands in for substance directly, rather than being checked only at the overlap
    // step below.
    expect(result.kind).toBe('aligned');
  });

  it('should accept a claim whose numeric statement is directly supported by its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
      quotes: ['at a cap rate of approximately 6.10%'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should accept a legitimate heavy paraphrase sharing few surface tokens', () => {
    const result = checkQuoteAlignment({
      statement: 'The lease includes two successive five-year renewal options.',
      quotes: [
        'Tenant shall have the right to extend the Term for two (2) successive periods of five (5) years each.',
      ],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should align a claim sharing a word token and a corroborated numeric token with its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'The sale amount recorded was $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
      corroboratedNumericTokens: new Set([41_000_000]),
    });

    // "sale" (a word token) is shared once — below MIN_SHARED_CONTENT_TOKENS (2) on its own, since an
    // uncorroborated number never pools with a word count toward that floor — but the corroborated
    // number 41000000 clears the overlap gate independently.
    expect(result.kind).toBe('aligned');
  });

  it('should reject a claim sharing a word token and an uncorroborated numeric token with its quote', () => {
    const result = checkQuoteAlignment({
      statement: 'The sale amount recorded was $41,000,000.',
      quotes: ['Sale Price (USD): 41000000'],
    });

    // Same shared word ("sale") and shared number as above, but with no corroboration: the shared
    // number no longer pools with the single shared word to reach MIN_SHARED_CONTENT_TOKENS.
    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should align a claim and quote in Cyrillic sharing enough word tokens, rather than erasing them', () => {
    const result = checkQuoteAlignment({
      statement: 'Северный Бизнес Парк был продан за сорок один миллион долларов.',
      quotes: ['Северный Бизнес Парк был продан в марте.'],
    });

    // Before Unicode-aware splitting, every character here falls outside `[^a-z0-9]+`'s complement,
    // so both statement and quote would tokenize to nothing, fail the substance floor at zero
    // content tokens, and could never align regardless of what they say. Splitting on `\p{L}`/`\p{N}`
    // extracts the real words, and "северный", "бизнес", "парк", "был", "продан" are shared,
    // clearing MIN_SHARED_CONTENT_TOKENS on word overlap alone — no numeric corroboration involved.
    expect(result.kind).toBe('aligned');
  });

  it('should pool content tokens across multiple quotes on the same claim', () => {
    const result = checkQuoteAlignment({
      statement: 'The lease includes two successive five-year renewal options.',
      quotes: ['two (2) successive periods', 'of five (5) years each'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should ignore stopwords and sub-length tokens when counting content', () => {
    const result = checkQuoteAlignment({
      statement:
        'The and for that with this from was were have shall each are its into upon such any all may can.',
      quotes: ['The and for that with.'],
    });

    expect(result.kind).toBe('quote-not-substantive');
  });

  it('should reject a claim whose statement negates a quote it otherwise shares enough words with', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was not renovated in 2024.',
      quotes: ['Northgate Business Park was renovated in 2024.'],
    });

    // "northgate", "business", "park", "renovated" are shared and clear the overlap gate on their
    // own — before this check existed, that was enough to align a claim that flatly negates the
    // fact its own quote states. "not" itself is absent from the quote, so it never becomes a
    // shared token either way; the polarity check is what catches this, not the overlap count.
    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it('should reject a claim whose quote is negated but whose statement is not', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was renovated in 2024.',
      quotes: ["The Tenant hasn't renovated Northgate Business Park in 2024."],
    });

    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it('should align a negated claim whose quote is negated the same way', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park was not renovated in 2024.',
      quotes: ['The Tenant did not renovate Northgate Business Park in 2024.'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should require more shared tokens for a longer statement than the fixed floor would have', () => {
    const statement =
      'The renovated Northgate Business Park complex recently completed a substantial capital improvement project across its retail leasing portfolio this quarter.';
    const result = checkQuoteAlignment({
      statement,
      quotes: ['Northgate Business Park was sold last year.'],
    });

    // Shares "northgate", "business", "park" — 3 tokens, which cleared the old fixed floor of 2 but
    // is below this 16-content-word statement's proportional floor of `ceil(16 * 0.2)` = 4.
    expect(result.kind).toBe('quote-unrelated-to-statement');
  });

  it('should refuse alignment for a claim and quote written in unsegmented CJK script', () => {
    const result = checkQuoteAlignment({
      statement: '北京大厦于2024年出售，成交价为四千一百万美元。',
      quotes: ['北京大厦于2024年出售，成交价为四千一百万美元。'],
    });

    // Verbatim-identical statement and quote — the strongest possible lexical match — still refuses,
    // because Han script carries no whitespace between words and this codebase has no segmentation
    // dependency to tokenize it at word granularity. Refusing is the chosen failure mode over
    // accepting a coarse, unreliable match (see the module's own doc comment and the ADR it cites).
    expect(result.kind).toBe('quote-script-unsupported');
  });

  it('should refuse alignment when only the quote, not the statement, carries unsegmented CJK script', () => {
    const result = checkQuoteAlignment({
      statement: 'Northgate Business Park sold for a large amount.',
      quotes: ['北京大厦于2024年出售，成交价为四千一百万美元。'],
    });

    expect(result.kind).toBe('quote-script-unsupported');
  });

  it('should catch a positive statement citing a quote whose negation is hidden by a zero-width space', () => {
    // U+200B ZERO WIDTH SPACE sits inside "not", between the "n" and the "ot" — invisible in any
    // rendering, but enough to defeat a plain `\bnot\b` match on unstripped text.
    const result = checkQuoteAlignment({
      statement: 'The premises are compliant with fire code.',
      quotes: ['The premises are n​ot compliant with fire code.'],
    });

    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it('should catch a positive statement citing a quote whose negation is hidden by a soft hyphen', () => {
    // U+00AD SOFT HYPHEN is the same shape of gap as the zero-width space above, but this one is not
    // purely adversarial: PDF extractors routinely emit it at hyphenated line breaks.
    const result = checkQuoteAlignment({
      statement: 'The premises are compliant with fire code.',
      quotes: ['The premises are n­ot compliant with fire code.'],
    });

    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it('should catch a positive statement citing a quote whose negation is written in full-width Latin', () => {
    // "ｎｏｔ" is fullwidth Latin "not" (U+FF4E/FF4F/FF54) — a compatibility variant NFKC
    // folds to plain ASCII "not" before the polarity gate runs.
    const result = checkQuoteAlignment({
      statement: 'The premises are compliant with fire code.',
      quotes: ['The premises are ｎｏｔ compliant with fire code.'],
    });

    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it.each([
    ['U+0001 START OF HEADING (Cc)', '\u0001'],
    ['U+001F UNIT SEPARATOR (Cc)', '\u001F'],
    ['U+007F DELETE (Cc)', '\u007F'],
    ['U+0085 NEXT LINE (Cc)', '\u0085'],
    ['U+009F APPLICATION PROGRAM COMMAND (Cc)', '\u009F'],
    ['U+0600 ARABIC NUMBER SIGN (Cf)', '؀'],
    ['U+070F SYRIAC ABBREVIATION MARK (Cf)', '܏'],
    ['U+0301 COMBINING ACUTE ACCENT (Mn)', '́'],
    ['U+0489 COMBINING CYRILLIC MILLIONS SIGN (Me)', '҉'],
    ['U+2028 LINE SEPARATOR (Zl)', '\u2028'],
    ['U+2029 PARAGRAPH SEPARATOR (Zp)', '\u2029'],
    ['U+3000 IDEOGRAPHIC SPACE (Zs, non-ASCII)', '　'],
    ['U+2800 BRAILLE PATTERN BLANK (So, renders blank)', '\u2800'],
  ])(
    'should catch a positive statement citing a quote whose negation is hidden by %s planted mid-word',
    (_label, codePoint) => {
      const result = checkQuoteAlignment({
        statement: 'The premises are compliant with fire code.',
        quotes: [`The premises are n${codePoint}ot compliant with fire code.`],
      });

      expect(result.kind).toBe('quote-contradicts-statement');
    },
  );

  it('should still catch a negation marker sitting directly against visible ASCII punctuation, with no surrounding space', () => {
    // "not-remediated" has no invisible or unusual character at all — an ordinary hyphen a reader
    // sees as separating "not" from "remediated". Squashing the negation-detection projection down
    // to letters, digits, and printable ASCII (rather than to letters, digits, and space alone) is
    // what keeps this hyphen in place: a narrower squash that dropped ordinary punctuation would
    // merge "not" into "notremediated", losing the `\b` boundary `\bnot\b` needs and un-detecting a
    // negation the quote plainly states.
    const result = checkQuoteAlignment({
      statement: 'The site was remediated.',
      quotes: ['The site was not-remediated.'],
    });

    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it('should refuse alignment when a quote spells a negation marker with a Cyrillic look-alike letter', () => {
    // "nоt" mixes Latin "n"/"t" with Cyrillic "о" (U+043E, not Latin "o", U+006F) — reads as
    // "not" but shares no codepoint-level relationship with it that NFKC or any other normalization
    // form could fold away, so the polarity gate cannot see it as a negation either way. Refused
    // outright rather than silently scored as a polarity match.
    const result = checkQuoteAlignment({
      statement: 'The premises are compliant with fire code.',
      quotes: ['The premises are nоt compliant with fire code.'],
    });

    expect(result.kind).toBe('quote-mixed-script');
  });

  it('should refuse alignment when the statement, not the quote, carries a mixed-script token', () => {
    const result = checkQuoteAlignment({
      statement: 'The premises are nоt compliant with fire code.',
      quotes: ['The premises are compliant with fire code.'],
    });

    expect(result.kind).toBe('quote-mixed-script');
  });

  it('should not flag a claim and quote written entirely in one non-Latin script as mixed-script', () => {
    // The existing Cyrillic-alignment case above already proves a single-script, non-Latin claim
    // aligns; this proves the new mixed-script gate does not regress it — no token here combines two
    // scripts, so `quote-mixed-script` must not fire ahead of the ordinary alignment gates.
    const result = checkQuoteAlignment({
      statement: 'Северный Бизнес Парк был продан за сорок один миллион долларов.',
      quotes: ['Северный Бизнес Парк был продан в марте.'],
    });

    expect(result.kind).toBe('aligned');
  });

  it('should align a claim citing a quote that uses the micro sign in a measurement unit, while still refusing an ohm sign and a Cyrillic homoglyph', () => {
    const alignedResult = checkQuoteAlignment({
      statement: 'Groundwater at the site showed benzene concentrations of 12 µg/m3.',
      quotes: ['Benzene concentrations in groundwater at the site were 12 µg/m3.'],
    });

    // U+00B5 MICRO SIGN carries `Script=Common` before NFKC folding. Folding it to Greek mu
    // (U+03BC) first — the way `canonicalizeForAlignment` does for token overlap — would make "µg"
    // read as mixing Greek with the surrounding Latin letters at the mixed-script gate, refusing a
    // unit routine in a Phase I environmental site assessment.
    expect(alignedResult.kind).toBe('aligned');

    const ohmResult = checkQuoteAlignment({
      statement: 'Electrical resistance across the circuit measured 4 kΩ.',
      quotes: ['The circuit measured 4 kΩ of resistance.'],
    });

    // U+2126 OHM SIGN carries `Script=Greek` even before NFKC folding, unlike the micro sign above —
    // checking the mixed-script gate pre-fold closes no coverage for a symbol that already carried a
    // non-Latin script identity, so "kΩ" still refuses precisely as it did before this check moved to
    // a pre-fold projection.
    expect(ohmResult.kind).toBe('quote-mixed-script');

    const refusedResult = checkQuoteAlignment({
      statement: 'The premises are compliant with fire code.',
      quotes: ['The premises are nоt compliant with fire code.'],
    });

    // The Cyrillic "о" substitution above is unaffected: it carries `Script=Cyrillic` both before
    // and after NFKC folding, so checking the mixed-script gate pre-fold closes no coverage this
    // gate already provided.
    expect(refusedResult.kind).toBe('quote-mixed-script');
  });

  it('should not treat "including without limitation" boilerplate as a negation', () => {
    const result = checkQuoteAlignment({
      statement: 'The tenant may remove trade fixtures and equipment at lease end.',
      quotes: [
        'Tenant may remove, including without limitation, all trade fixtures and equipment installed by Tenant.',
      ],
    });

    // Before the without/limitation exclusion, the bare "without" alternation flagged the quote as
    // negated while the statement was not, and this fell out as `quote-contradicts-statement` even
    // though neither side actually negates anything.
    expect(result.kind).toBe('aligned');
  });

  it('should still treat "without" as a negation marker outside the "without limitation" phrase', () => {
    const result = checkQuoteAlignment({
      statement: 'The tenant may vacate the premises without notice.',
      quotes: ['Tenant shall have the right to vacate the premises at any time.'],
    });

    // The statement's "without" carries no following "limitation", so it still counts as a negation
    // marker; the quote carries none, so polarity disagrees.
    expect(result.kind).toBe('quote-contradicts-statement');
  });

  it("should still require locateQuote to match a quote's invisible characters verbatim, not canonicalize them away", () => {
    const chunkText = 'The premises are not compliant with fire code.';
    const quoteWithZeroWidthSpace = 'The premises are n​ot compliant with fire code.';

    const match = locateQuote(quoteWithZeroWidthSpace, chunkText);

    // If `locate-quote.util.ts` canonicalized the way `checkQuoteAlignment`'s polarity/overlap gates
    // now do, this would read `exact` — the point of leaving `normalizeQuoteText` untouched is that
    // this path keeps proving the quote's real bytes are present in the chunk, not merely that the
    // two read the same after stripping and folding.
    expect(match.kind).not.toBe('exact');
  });

  describe('perceived word breaks', () => {
    // The domain is enumerated from Unicode's own properties over the whole code point space, never
    // sampled: `\p{Zs}` is every space separator, and `\p{Pattern_White_Space}` adds the separators
    // Unicode itself designates as pattern whitespace (tab, LF, VT, FF, CR, NEL, LRM, RLM, and the
    // line/paragraph separators). Scanning rather than listing keeps the domain correct when Unicode
    // adds a member — a list would silently stop covering the class.
    const LAST_CODE_POINT = 0x10ffff;

    function codePointsMatching(property: RegExp): number[] {
      const matches: number[] = [];
      for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
        if (property.test(String.fromCodePoint(codePoint))) matches.push(codePoint);
      }
      return matches;
    }

    function label(codePoint: number): string {
      return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    }

    function asCases(codePoints: readonly number[]): [string, string][] {
      return codePoints.map((codePoint) => [label(codePoint), String.fromCodePoint(codePoint)]);
    }

    const SPACE_SEPARATORS = codePointsMatching(/\p{Zs}/u);
    const PERCEIVED_WORD_BREAKS = [
      ...new Set([...SPACE_SEPARATORS, ...codePointsMatching(/\p{Pattern_White_Space}/u)]),
    ].sort((first, second) => first - second);

    it('should enumerate both properties from the code point space, not from a hardcoded list', () => {
      // A regex engine that silently failed to recognize either property would make every sweep
      // below vacuous — an empty `it.each` table reports zero failures, not zero coverage.
      expect(SPACE_SEPARATORS.length).toBeGreaterThanOrEqual(17);
      expect(PERCEIVED_WORD_BREAKS.length).toBeGreaterThanOrEqual(27);
    });

    it.each(asCases(PERCEIVED_WORD_BREAKS))(
      'should catch a quote hiding a negation behind %s used as the separator around "not"',
      (_label, separator) => {
        const result = checkQuoteAlignment({
          statement: 'The property was renovated in 2024 by the owner.',
          quotes: [`The property was${separator}not${separator}renovated in 2024 by the owner.`],
        });

        // Deleting a separator a reader perceives as a word break removes the `\b` boundary the
        // negation markers are matched on, so "not" stops being a whole word and the negation
        // becomes invisible to the polarity gate while still rendering as a gap on the page.
        expect(result.kind).toBe('quote-contradicts-statement');
      },
    );

    it.each(asCases(PERCEIVED_WORD_BREAKS))(
      'should catch a statement hiding a negation behind %s used as the separator around "not"',
      (_label, separator) => {
        const result = checkQuoteAlignment({
          statement: `The property was${separator}not${separator}renovated in 2024 by the owner.`,
          quotes: ['The property was renovated in 2024 by the owner.'],
        });

        // The statement is model-authored, so the bypass runs in this direction too: a reader sees a
        // negated claim above a quote that states the opposite.
        expect(result.kind).toBe('quote-contradicts-statement');
      },
    );

    // Tab, LF, VT, FF, CR and U+0020 are excluded from the mid-word sweep below and from nothing
    // else: each renders as a gap of its own, so a reader of `n<tab>ot` sees "n ot" and no negation
    // is being hidden from anyone. Every remaining member renders as nothing or as a gap a reader
    // reads as ordinary spacing, which is what makes one planted inside a marker word a hiding place.
    const MID_WORD_HIDING_PLACES = PERCEIVED_WORD_BREAKS.filter(
      (codePoint) => codePoint !== 0x20 && (codePoint < 0x09 || codePoint > 0x0d),
    );

    it.each(asCases(MID_WORD_HIDING_PLACES))(
      'should catch a quote hiding a negation behind %s planted inside "not"',
      (_label, hidden) => {
        const result = checkQuoteAlignment({
          statement: 'The property was renovated in 2024 by the owner.',
          quotes: [`The property was n${hidden}ot renovated in 2024 by the owner.`],
        });

        // The other axis of the same class: the separator sweeps above are defeated by reading a
        // planted code point as absent, and this one is defeated by reading it as a word break, so
        // pinning only one of the two leaves the gate closed from a single side.
        expect(result.kind).toBe('quote-contradicts-statement');
      },
    );

    it.each(asCases(SPACE_SEPARATORS))(
      'should align a quote using %s as an ordinary word separator, tokenizing it at word granularity',
      (_label, separator) => {
        const statement =
          'The Northgate Business Park retail complex completed a substantial capital improvement project across its leasing portfolio during the most recent quarter.';
        const sharedWords = ['completed', 'substantial', 'capital', 'improvement'].join(separator);
        const result = checkQuoteAlignment({
          statement,
          quotes: [`Tenant records show the ${sharedWords} undertaking was delivered.`],
        });

        // The statement carries 17 word tokens, so its proportional floor is 4 shared word tokens and
        // the quote shares exactly those four. Any separator that glued them into one token would
        // drop the shared count to zero — aligning here is the assertion that all four survive as
        // separate tokens. U+2007, U+2009 and U+202F are routine PDF text-extraction and
        // `Intl.DateTimeFormat` output, and U+3000 is the standard CJK word separator.
        expect(result.kind).toBe('aligned');
      },
    );
  });
});
