import { normalizeQuoteText } from '../../../src/shared/utils/normalize-quote-text.util';

describe('normalizeQuoteText', () => {
  it('should collapse a reflowed line break into a single space', () => {
    expect(normalizeQuoteText('at a cap rate of\napproximately 6.10%')).toBe(
      'at a cap rate of approximately 6.10%',
    );
  });

  it('should collapse multiple consecutive whitespace characters into one space', () => {
    expect(normalizeQuoteText('revenue   grew\t\t12%')).toBe('revenue grew 12%');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(normalizeQuoteText('  Northgate Business Park  ')).toBe('Northgate Business Park');
  });

  it('should normalize curly single quotes to a straight apostrophe', () => {
    expect(normalizeQuoteText('the tenant’s lease')).toBe("the tenant's lease");
    expect(normalizeQuoteText('‘quoted’')).toBe("'quoted'");
  });

  it('should normalize curly double quotes to a straight double quote', () => {
    expect(normalizeQuoteText('“cap rate”')).toBe('"cap rate"');
  });

  it('should normalize en dash, em dash, and minus sign to a hyphen-minus', () => {
    expect(normalizeQuoteText('2025–2026')).toBe('2025-2026');
    expect(normalizeQuoteText('2025—2026')).toBe('2025-2026');
    expect(normalizeQuoteText('−5%')).toBe('-5%');
  });

  it('should normalize a non-breaking space to a regular space', () => {
    // Built via ` ` escape rather than a literal glyph, so the character in the source is
    // unambiguous rather than relying on an invisible codepoint in the file.
    expect(normalizeQuoteText('6.10 %')).toBe('6.10 %');
  });

  it('should be the identity function for text with no reflow or unicode punctuation', () => {
    const text = 'Northgate Business Park traded at a cap rate of 6.10%.';
    expect(normalizeQuoteText(text)).toBe(text);
  });
});
