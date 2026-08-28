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
      expect(result.extractorVersion).toBe('text-block-3');
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
        expect(locator.extractorVersion).toBe('text-block-3');
      });
      expect(result.extractorVersion).toBe('text-block-3');
    });

    it('should produce an exact locator object for a body block and for a heading block', async () => {
      const content = Buffer.from('First.\n\n# Heading\n\nThird.');

      const result = await parser.parse(content);

      expect(result.elements[0].locator).toEqual({
        kind: 'text-block',
        blockIndex: 0,
        headingPath: [],
        extractorVersion: 'text-block-3',
      });
      expect(result.elements[1].locator).toEqual({
        kind: 'text-block',
        blockIndex: 1,
        headingPath: ['Heading'],
        extractorVersion: 'text-block-3',
      });
    });
  });

  describe('parse — encoding detection', () => {
    it('should decode a windows-1252 buffer, including a byte in the 0x80-0x9F range the cp1252 table remaps', async () => {
      // "Tenant’s" with the windows-1252 right-single-quote byte (0x92) — not a valid UTF-8
      // sequence on its own, so this exercises the windows-1252 fallback rather than accidentally
      // decoding as UTF-8.
      const content = Buffer.from([0x54, 0x65, 0x6e, 0x61, 0x6e, 0x74, 0x92, 0x73]);

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Tenant’s');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('windows-1252')]);
    });

    it('should decode a windows-1252 buffer using Latin-1-equivalent bytes above 0x9F', async () => {
      // "café" with 0xE9 for é — not a legal UTF-8 leading byte with no continuation bytes
      // following, so this also falls through to windows-1252.
      const content = Buffer.from([0x63, 0x61, 0x66, 0xe9]);

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('café');
    });

    it('should decode a UTF-16LE buffer carrying its BOM', async () => {
      const content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Rent Roll', 'utf16le'),
      ]);

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Rent Roll');
    });

    it('should decode a UTF-16BE buffer carrying its BOM', async () => {
      const little = Buffer.from('Rent Roll', 'utf16le');
      const big = Buffer.alloc(little.length);
      for (let i = 0; i < little.length; i += 2) {
        big[i] = little[i + 1];
        big[i + 1] = little[i];
      }
      const content = Buffer.concat([Buffer.from([0xfe, 0xff]), big]);

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Rent Roll');
    });

    it('should decode a BOM-less UTF-16LE buffer via the NUL-parity heuristic', async () => {
      const content = Buffer.from('Rent Roll figures for Q3', 'utf16le');

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Rent Roll figures for Q3');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('utf-16le')]);
    });

    it('should decode a windows-1252 body behind a UTF-8 BOM exactly as it decodes the same bytes unmarked, flag included', async () => {
      // A spreadsheet's "CSV UTF-8" export writes the BOM; a legacy tool can leave a cp1252 body
      // behind it. Trusting the BOM would store U+FFFD in place of the em-dash and the â.
      const body = Buffer.from([
        ...Buffer.from('Revenue rose 12% '),
        0x97,
        0x20,
        0x93,
        0x42,
        0xe2,
        0x6c,
        0x65,
        0x94,
      ]);
      const declared = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);

      const result = await parser.parse(declared);

      expect(result.elements[0].text).toBe('Revenue rose 12% — “Bâle”');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('windows-1252')]);
      expect(result).toEqual(await parser.parse(body));
    });

    it('should report no reduced-fidelity reason for an ordinary UTF-8 buffer', async () => {
      const result = await parser.parse(Buffer.from('First block.\n\nSecond block.'));

      expect(result.reducedFidelityReasons).toBeUndefined();
    });

    it('should report no reduced-fidelity reason for a UTF-8 BOM over genuine UTF-8 content', async () => {
      const content = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('Revenue rose 12% — “Bâle”', 'utf8'),
      ]);

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe('Revenue rose 12% — “Bâle”');
      expect(result.reducedFidelityReasons).toBeUndefined();
    });
  });

  describe('parse — trust-boundary separation (storage stays byte-faithful)', () => {
    it('should store a bidi-override character verbatim rather than neutralizing it — that happens only at the display boundary', async () => {
      const rightToLeftOverride = String.fromCharCode(0x202e);
      const content = Buffer.from(`Invoice${rightToLeftOverride}42.doc`, 'utf-8');

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe(`Invoice${rightToLeftOverride}42.doc`);
      expect(result.elements[0].text).toContain(rightToLeftOverride);
    });

    it('should store a zero-width space verbatim rather than stripping it', async () => {
      const zeroWidthSpace = String.fromCharCode(0x200b);
      const content = Buffer.from(`total${zeroWidthSpace}amount`, 'utf-8');

      const result = await parser.parse(content);

      expect(result.elements[0].text).toBe(`total${zeroWidthSpace}amount`);
    });
  });
});
