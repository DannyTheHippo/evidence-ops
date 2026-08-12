import type { TextBlockLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { TextParser } from '../../../../../src/features/evidence/ingestion/parsers/text.parser';

describe('TextParser', () => {
  let parser: TextParser;

  beforeEach(() => {
    parser = new TextParser();
  });

  describe('supports', () => {
    it('should claim text/plain and text/markdown', () => {
      expect(parser.supports).toEqual(['text/plain', 'text/markdown']);
    });
  });

  describe('parse — blank-line splitting', () => {
    it('should split on a single blank line and on a run of consecutive blank lines identically', async () => {
      const content = Buffer.from('First block.\n\nSecond block.\n\n\n\nThird block.');

      const result = await parser.parse(content);

      expect(result.elements.map((element) => element.text)).toEqual([
        'First block.',
        'Second block.',
        'Third block.',
      ]);
    });

    it('should join lines within a single block with a newline', async () => {
      const content = Buffer.from('Line one\nLine two\n\nNext block.');

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Line one\nLine two');
      expect(result.elements[1].text).toBe('Next block.');
    });

    it('should return no elements for an empty buffer', async () => {
      const result = await parser.parse(Buffer.from(''));

      expect(result.elements).toEqual([]);
      expect(result.extractorVersion).toBe('text-block-1');
    });

    it('should return no elements for a buffer containing only blank lines', async () => {
      const result = await parser.parse(Buffer.from('\n\n   \n\n'));

      expect(result.elements).toEqual([]);
    });
  });

  describe('parse — heading trail', () => {
    const DOCUMENT = [
      'Intro paragraph.',
      '',
      '',
      '# Title',
      '',
      'Some text under title.',
      '',
      '## Section A',
      '',
      'Text A.',
      '',
      '### Sub A1',
      '',
      'Text sub.',
      '',
      '## Section B',
      '',
      'Text B.',
    ].join('\n');

    it('should leave headingPath empty for a block that precedes any heading', async () => {
      const result = await parser.parse(Buffer.from(DOCUMENT));

      expect(result.elements[0].text).toBe('Intro paragraph.');
      expect(result.elements[0].headingPath).toEqual([]);
    });

    it("should stamp a heading block's own headingPath ending in its own title", async () => {
      const result = await parser.parse(Buffer.from(DOCUMENT));

      const titleBlock = result.elements.find((element) => element.text === 'Title');
      expect(titleBlock?.headingPath).toEqual(['Title']);
    });

    it('should carry the accumulated trail onto a body block nested under a heading', async () => {
      const result = await parser.parse(Buffer.from(DOCUMENT));

      const underTitle = result.elements.find(
        (element) => element.text === 'Some text under title.',
      );
      expect(underTitle?.headingPath).toEqual(['Title']);
    });

    it('should extend the trail one level per nested heading', async () => {
      const result = await parser.parse(Buffer.from(DOCUMENT));

      const sectionA = result.elements.find((element) => element.text === 'Section A');
      const textA = result.elements.find((element) => element.text === 'Text A.');
      const subA1 = result.elements.find((element) => element.text === 'Sub A1');
      const textSub = result.elements.find((element) => element.text === 'Text sub.');

      expect(sectionA?.headingPath).toEqual(['Title', 'Section A']);
      expect(textA?.headingPath).toEqual(['Title', 'Section A']);
      expect(subA1?.headingPath).toEqual(['Title', 'Section A', 'Sub A1']);
      expect(textSub?.headingPath).toEqual(['Title', 'Section A', 'Sub A1']);
    });

    it('should truncate the trail back to the new level when a shallower heading follows a deeper one', async () => {
      const result = await parser.parse(Buffer.from(DOCUMENT));

      const sectionB = result.elements.find((element) => element.text === 'Section B');
      const textB = result.elements.find((element) => element.text === 'Text B.');

      // Section A / Sub A1 are gone from the trail — proves truncation, not accumulation.
      expect(sectionB?.headingPath).toEqual(['Title', 'Section B']);
      expect(textB?.headingPath).toEqual(['Title', 'Section B']);
    });
  });

  describe('parse — non-heading `#` lines', () => {
    it('should treat a `#` line without a following space as body text, not a heading', async () => {
      const content = Buffer.from('#hashtag not a heading\n\nAfter.');

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('#hashtag not a heading');
      expect(result.elements[0].headingPath).toEqual([]);
      expect(result.elements[1].headingPath).toEqual([]);
    });
  });

  describe('parse — CRLF input', () => {
    it('should split blocks and detect headings the same way under CRLF line endings', async () => {
      const content = Buffer.from('# Heading\r\n\r\nBody text.\r\n');

      const result = await parser.parse(content);

      expect(result.elements).toHaveLength(2);
      expect(result.elements[0].text).toBe('Heading');
      expect(result.elements[1].text).toBe('Body text.');
      expect(result.elements[1].headingPath).toEqual(['Heading']);
    });
  });

  describe('parse — locators', () => {
    it('should stamp blockIndex zero-based, extractorVersion, and kind on every locator', async () => {
      const content = Buffer.from('First.\n\n# Heading\n\nThird.');

      const result = await parser.parse(content);

      result.elements.forEach((element, index) => {
        const locator = element.locator as TextBlockLocator;
        expect(locator.kind).toBe('text-block');
        expect(locator.blockIndex).toBe(index);
        expect(locator.extractorVersion).toBe('text-block-1');
      });
      expect(result.extractorVersion).toBe('text-block-1');
    });

    it('should produce an exact locator object for a body block and for a heading block', async () => {
      const content = Buffer.from('First.\n\n# Heading\n\nThird.');

      const result = await parser.parse(content);

      expect(result.elements[0].locator).toEqual({
        kind: 'text-block',
        blockIndex: 0,
        headingPath: [],
        extractorVersion: 'text-block-1',
      });
      expect(result.elements[1].locator).toEqual({
        kind: 'text-block',
        blockIndex: 1,
        headingPath: ['Heading'],
        extractorVersion: 'text-block-1',
      });
    });
  });
});
