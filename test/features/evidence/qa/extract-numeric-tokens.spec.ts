import {
  containsUnrepresentableNumber,
  extractNumericTokens,
} from '../../../../src/features/evidence/qa/extract-numeric-tokens';

describe('extractNumericTokens', () => {
  it('should extract a plain integer', () => {
    expect(extractNumericTokens('the lease term is 10 years')).toEqual([10]);
  });

  it('should extract a decimal percentage and strip the % sign', () => {
    expect(extractNumericTokens('a cap rate of 6.10%')).toEqual([6.1]);
  });

  it('should extract a dollar amount and strip the $ sign', () => {
    expect(extractNumericTokens('sold for $41000000')).toEqual([41_000_000]);
  });

  it('should extract a comma-grouped number as the same value as its ungrouped form', () => {
    expect(extractNumericTokens('the sale price was $12,500,000')).toEqual([12_500_000]);
    expect(extractNumericTokens('the sale price was $12500000')).toEqual([12_500_000]);
  });

  it('should parse "6.1" and "6.10" to the same numeric value', () => {
    // Motivates comparing parsed numbers instead of raw substrings: a naive
    // `chunkText.includes('6.1')` would match inside "6.10" coincidentally, and a naive
    // `chunkText.includes('6.10')` would miss a chunk that only ever writes "6.1" — parsing both
    // sides to numbers and comparing with `===` is correct in both directions.
    expect(extractNumericTokens('6.1')[0]).toBe(extractNumericTokens('6.10')[0]);
  });

  it('should extract multiple numbers from the same text in order', () => {
    expect(extractNumericTokens('revenue grew from 100 to 125 over 2 years')).toEqual([
      100, 125, 2,
    ]);
  });

  it('should return an empty array for text with no numbers', () => {
    expect(extractNumericTokens('Northgate Business Park traded last quarter')).toEqual([]);
  });

  it('should not parse a hyphenated span as a negative number', () => {
    // "2025-03" is a period, not "2025" minus "3" — a bare leading minus sign is deliberately not
    // supported (see the module's own comment) to avoid this misread.
    expect(extractNumericTokens('reported for period 2025-03')).toEqual([2025, 3]);
  });

  it('should not parse an A1-style cell range as a negative number', () => {
    expect(extractNumericTokens('see range A1:C10 for detail')).toEqual([1, 10]);
  });

  describe('accounting-negative parentheses', () => {
    it('should parse a bare parenthesized digit run as its negative value', () => {
      expect(extractNumericTokens('NOI declined to (41,000) this quarter')).toEqual([-41_000]);
    });

    it('should parse a dollar-outside-parens accounting negative as its negative value', () => {
      expect(extractNumericTokens('NOI is $(41,000)')).toEqual([-41_000]);
    });

    it('should parse a dollar-inside-parens accounting negative as its negative value', () => {
      // The form `xlsx.parser.ts`'s `formatNumber` actually emits for a `#,##0;(#,##0)`-style
      // negative section with a `$` prefix: the whole formatted body, prefix included, sits inside
      // the parens.
      expect(extractNumericTokens('NOI is ($41,000)')).toEqual([-41_000]);
    });

    it('should parse a parenthesized negative percentage', () => {
      expect(extractNumericTokens('yield compressed by (5.25%)')).toEqual([-5.25]);
    });

    it('should preserve original text order when a negative accounting figure follows a positive number', () => {
      expect(extractNumericTokens('revenue was $100 but NOI was $(41,000)')).toEqual([
        100, -41_000,
      ]);
    });

    it('should drop a parenthesized digit run past Number.MAX_SAFE_INTEGER rather than return a lossy negative', () => {
      expect(extractNumericTokens('the balance was (9007199254740993) exactly')).toEqual([]);
    });
  });

  it('should normalize a spelled-out cardinal number to its digit value', () => {
    expect(extractNumericTokens('a six percent yield')).toEqual([6]);
  });

  it('should normalize a spelled-out number with a decimal "point" clause', () => {
    expect(extractNumericTokens('a cap rate of six point one percent')).toEqual([6.1]);
  });

  it('should normalize a large spelled-out number using standard English number grammar', () => {
    expect(extractNumericTokens('the property sold for forty one million dollars')).toEqual([
      41_000_000,
    ]);
  });

  it('should preserve original text order when merging digit and spelled-out matches', () => {
    expect(extractNumericTokens('revenue was $10 and grew by six percent')).toEqual([10, 6]);
  });

  it('should not treat a bare, unscaled "one" as a number (pronoun ambiguity)', () => {
    expect(extractNumericTokens('the only one option remains')).toEqual([]);
  });

  it('should still extract "one" when it is scaled ("one hundred") or has a decimal point', () => {
    expect(extractNumericTokens('one hundred dollars')).toEqual([100]);
    expect(extractNumericTokens('six point one')).toEqual([6.1]);
  });

  it('should not spell out ordinals or fractions as numbers (known gap, documented)', () => {
    expect(extractNumericTokens('the sixth floor has half the units')).toEqual([]);
  });

  it('should not invent a magnitude from a scale word trailing a digit (known gap, documented)', () => {
    // "$41" and "million" tokenize separately (digits are not `\p{L}`), so the word scanner sees a
    // bare "million" with no cardinal word anchoring it — dropped, not extracted as 1,000,000, or
    // this would silently invent a second number the statement never actually states.
    expect(extractNumericTokens('sold for $41 million')).toEqual([41]);
  });

  it('should not extract a bare, unanchored scale word as a number', () => {
    expect(extractNumericTokens('a million dollars')).toEqual([]);
  });

  it('should not resolve a lowercased Object.prototype key ("constructor") as a cardinal word', () => {
    // Regression: `word in ONES` / `SCALES[word]` on a plain object literal traverse
    // `Object.prototype`, and "constructor" is the one prototype member that survives lowercasing
    // (`toString`/`valueOf`/`hasOwnProperty` are already lowercase; `__proto__` tokenizes to "proto"
    // since `_` is not `\p{L}`). Left unguarded, `SCALES['constructor']` resolves to the `Object`
    // function and arithmetic on it produces `NaN`.
    expect(extractNumericTokens('The site had five constructor bids submitted.')).toEqual([5]);
    expect(extractNumericTokens('Area is two hundred constructor sf.')).toEqual([200]);
  });

  it('should not resolve a second lowercased Object.prototype key ("hasownproperty") as a cardinal word', () => {
    expect(extractNumericTokens('nine hasownproperty units')).toEqual([9]);
  });

  it('should drop a digit run long enough to overflow to Infinity', () => {
    expect(extractNumericTokens(`The figure is 1${'0'.repeat(400)} exactly.`)).toEqual([]);
  });

  it('should drop a spelled-out number long enough to overflow to Infinity', () => {
    // `current = (current === 0 ? 1 : current) * 100` chained across ~200 repeated "hundred"s
    // overflows a double to `Infinity` before this module ever normalizes it to a returned value.
    expect(extractNumericTokens(`nine ${'hundred '.repeat(200)}dollars`)).toEqual([]);
  });

  it('should drop a digit run past Number.MAX_SAFE_INTEGER rather than return a lossy double', () => {
    // Two distinct 17-significant-digit source numbers that both round to the same IEEE-754 double
    // must not both extract as that double — the whole point of extracting "as parsed numbers, not
    // substrings" is defeated if two different substrings can silently collide on one parsed value.
    expect(extractNumericTokens('The figure is 9007199254740993 exactly.')).toEqual([]);
    expect(extractNumericTokens('The figure is 9007199254740992 exactly.')).toEqual([]);
  });

  it('should still extract a digit run at or below Number.MAX_SAFE_INTEGER', () => {
    expect(extractNumericTokens(`The figure is ${Number.MAX_SAFE_INTEGER} exactly.`)).toEqual([
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it('should fold full-width ASCII digits to the same value as their plain ASCII form', () => {
    expect(extractNumericTokens('１２２００ square feet')).toEqual([12200]);
    expect(extractNumericTokens('12200 square feet')).toEqual([12200]);
  });

  it('should omit an Arabic-Indic digit run rather than return a value for it', () => {
    // A script NFKC does not fold to ASCII — `extractNumericTokens` has no value to parse it into,
    // and the invariant test below pins that it is omitted, not represented by any sentinel.
    expect(extractNumericTokens('المساحة ١٢٢٠٠ قدم مربع')).toEqual([]);
  });

  it('should omit a Devanagari digit run, another script NFKC does not fold to ASCII', () => {
    expect(extractNumericTokens('क्षेत्रफल १२२०० वर्ग फुट है')).toEqual([]);
  });

  it('should still extract a real number from a mixed statement while omitting the unparseable one', () => {
    expect(extractNumericTokens('sold for $10 then ١٢٢٠٠ recorded later')).toEqual([10]);
  });

  it('should still extract a real number from a mixed statement while omitting an over-magnitude one', () => {
    // The magnitude counterpart of the script case above: `$5,400` is representable and extracted
    // normally; the 18-digit account number alongside it is not, and is omitted, not represented by a
    // lossy or sentinel value.
    expect(extractNumericTokens('valued at $5,400 against account 123456789012345678')).toEqual([
      5400,
    ]);
  });

  describe('the finite-return invariant', () => {
    // `extractNumericTokens` promises every element it returns is finite — never `NaN`, never
    // `Infinity` — so a caller comparing with `Array.prototype.includes` or `Set` membership
    // (SameValueZero, which treats `NaN` as equal to itself) is correct without special-casing an
    // unrepresentable-number sentinel. Pinning the property itself, across an adversarial input each
    // covering a distinct way this module could fail to return a real value — wrong script, digit-run
    // overflow, word-number overflow, an over-`MAX_SAFE_INTEGER` magnitude, a prototype-key word, and a
    // mix of representable and unrepresentable — is what would have caught the class of defect a single
    // fixed-input assertion cannot: any future change reintroducing a non-finite element anywhere in the
    // merge passes every individual `toEqual` above yet fails here.
    const adversarialInputs = [
      'المساحة ١٢٢٠٠ قدم مربع', // Arabic-Indic digits, wrong script
      'क्षेत्रफल १२२०० वर्ग फुट है', // Devanagari digits, wrong script
      '１２２００ square feet', // full-width ASCII, folds and parses
      `The figure is 1${'0'.repeat(400)} exactly.`, // digit-run overflow to Infinity
      `nine ${'hundred '.repeat(200)}dollars`, // word-number overflow to Infinity
      'The site had five constructor bids submitted.', // Object.prototype key as a word
      `The figure is ${Number.MAX_SAFE_INTEGER} exactly.`, // at the safe boundary, must parse
      'Account 123456789012345678 was credited.', // an 18-digit identifier, over the safe boundary
      'valued at $5,400 against account 123456789012345678', // representable + over-magnitude mix
      'sold for $10 then ١٢٢٠٠ recorded later', // representable + wrong-script mix
      'the balance was (9007199254740993) exactly', // negative accounting figure, over-magnitude
    ];

    it.each(adversarialInputs)('should return only finite values for: %s', (input) => {
      for (const token of extractNumericTokens(input)) {
        expect(Number.isFinite(token)).toBe(true);
      }
    });
  });
});

describe('containsUnrepresentableNumber', () => {
  it('should be false for text with no digits at all', () => {
    expect(containsUnrepresentableNumber('Northgate Business Park traded last quarter')).toBe(
      false,
    );
  });

  it('should be false for an ASCII digit run', () => {
    expect(containsUnrepresentableNumber('the lease term is 10 years')).toBe(false);
  });

  it('should be false for a full-width ASCII digit run, which NFKC folds to plain ASCII', () => {
    expect(containsUnrepresentableNumber('１２２００ square feet')).toBe(false);
  });

  it('should be true for an Arabic-Indic digit run', () => {
    expect(containsUnrepresentableNumber('المساحة ١٢٢٠٠ قدم مربع')).toBe(true);
  });

  it('should be true for a Devanagari digit run', () => {
    expect(containsUnrepresentableNumber('क्षेत्रफल १२२०० वर्ग फुट है')).toBe(true);
  });

  it('should be true when a wrong-script digit run appears alongside a real number', () => {
    expect(containsUnrepresentableNumber('sold for $10 then ١٢٢٠٠ recorded later')).toBe(true);
  });

  it('should be false for a digit run at exactly Number.MAX_SAFE_INTEGER', () => {
    expect(containsUnrepresentableNumber(`The figure is ${Number.MAX_SAFE_INTEGER} exactly.`)).toBe(
      false,
    );
  });

  it('should be true for a digit run past Number.MAX_SAFE_INTEGER', () => {
    expect(
      containsUnrepresentableNumber(`The figure is ${Number.MAX_SAFE_INTEGER + 2} exactly.`),
    ).toBe(true);
  });

  it('should be true for an 18-digit identifier, a legible number outside the safe integer range', () => {
    expect(containsUnrepresentableNumber('Account 123456789012345678 was credited.')).toBe(true);
  });

  it('should be false for a parenthesized accounting negative within the safe integer range', () => {
    expect(containsUnrepresentableNumber('NOI is $(41,000)')).toBe(false);
  });

  it('should be true for a parenthesized accounting negative past Number.MAX_SAFE_INTEGER', () => {
    expect(containsUnrepresentableNumber('the balance was (9007199254740993) exactly')).toBe(true);
  });

  it('should be true for a digit run long enough to overflow to Infinity', () => {
    expect(containsUnrepresentableNumber(`The figure is 1${'0'.repeat(400)} exactly.`)).toBe(true);
  });

  it('should be true when an over-magnitude digit run appears alongside a representable number', () => {
    expect(
      containsUnrepresentableNumber('valued at $5,400 against account 123456789012345678'),
    ).toBe(true);
  });

  it('should be false for a spelled-out number that overflows, which carries no digit run at all', () => {
    // Deliberate exclusion, per `containsUnrepresentableNumber`'s own doc comment: a run of 200
    // repeated "hundred"s is not a digit run and not a real spelled-out number a document or a model
    // would ever produce for an actual quantity — the pathological construction that induces the
    // overflow is itself the reason this input carries nothing a reader would recognize as a stated
    // number, so silently extracting nothing for it is the correct outcome, not a gap to signal.
    expect(containsUnrepresentableNumber(`nine ${'hundred '.repeat(200)}dollars`)).toBe(false);
  });
});
