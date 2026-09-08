import type { TextBlockLocator } from '../../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedHtmlException } from '../../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import {
  HTML_MAX_BYTES,
  HTML_MAX_EMITTED_ELEMENTS,
  HTML_MAX_NESTING_DEPTH,
  HtmlParser,
} from '../../../../../src/features/evidence/ingestion/parsers/html.parser';
import { sanitizeEvidenceText } from '../../../../../src/features/evidence/ingestion/sanitize-evidence-text';
import type { ParsedDocument } from '../../../../../src/features/evidence/ingestion/parsers/parsed-element.type';

function textBlocks(result: ParsedDocument): { text: string; locator: TextBlockLocator }[] {
  return result.elements
    .filter(
      (element): element is typeof element & { locator: TextBlockLocator } =>
        element.locator.kind === 'text-block',
    )
    .map((element) => ({ text: element.text, locator: element.locator }));
}

function findCellElement(result: ParsedDocument, sheetName: string, cell: string) {
  return result.elements.find(
    (element) =>
      element.locator.kind === 'xlsx-cell' &&
      element.locator.sheetName === sheetName &&
      element.locator.cell === cell,
  );
}

function allText(result: ParsedDocument): string {
  return result.elements.map((element) => element.text).join('\n');
}

describe('HtmlParser', () => {
  let parser: HtmlParser;

  beforeEach(() => {
    parser = new HtmlParser();
  });

  it('should carry the text/html MIME type', () => {
    expect(parser.supports).toEqual(['text/html']);
  });

  describe('parse — dropped content (fails closed toward exclusion)', () => {
    const CANARY = 'SECRET_CANARY_TEXT';

    it.each([
      ['script', `<p>visible</p><script>${CANARY}</script>`],
      ['style', `<p>visible</p><style>.x { content: "${CANARY}"; }</style>`],
      ['template', `<p>visible</p><template>${CANARY}</template>`],
      ['noscript', `<p>visible</p><noscript>${CANARY}</noscript>`],
      ['iframe', `<p>visible</p><iframe>${CANARY}</iframe>`],
      ['object', `<p>visible</p><object>${CANARY}</object>`],
      ['embed', `<p>visible</p><embed title="${CANARY}">`],
      ['head', `<html><head><title>${CANARY}</title></head><body><p>visible</p></body></html>`],
      ['comment', `<p>visible</p><!-- ${CANARY} -->`],
      ['doctype', `<!DOCTYPE html><!-- placeholder --><p>visible</p>`],
      ['hidden attribute', `<p>visible</p><div hidden>${CANARY}</div>`],
      ['display:none style', `<p>visible</p><div style="display: none;">${CANARY}</div>`],
      ['visibility:hidden style', `<p>visible</p><div style="visibility:hidden">${CANARY}</div>`],
      ['input[type=hidden]', `<p>visible</p><input type="hidden" value="${CANARY}">`],
      // Extension beyond the plan's own six raw-text/RCDATA tags — see html.parser.ts's own
      // `DROP_TAGS` doc comment for why each is dropped rather than emitted.
      ['textarea', `<p>visible</p><textarea>${CANARY}</textarea>`],
      ['title (in body)', `<p>visible</p><title>${CANARY}</title>`],
      ['xmp', `<p>visible</p><xmp>${CANARY}</xmp>`],
      ['noembed', `<p>visible</p><noembed>${CANARY}</noembed>`],
      ['noframes', `<p>visible</p><noframes>${CANARY}</noframes>`],
    ])('should never let %s content reach an emitted element', async (_label, html) => {
      const result = await parser.parse(Buffer.from(html));

      expect(allText(result)).not.toContain(CANARY);
      expect(allText(result)).toContain('visible');
    });

    it("should drop a doctype-only document's DOCTYPE token itself without refusing", async () => {
      const result = await parser.parse(Buffer.from('<!DOCTYPE html><p>visible</p>'));

      expect(allText(result)).toBe('visible');
    });
  });

  describe('parse — entities (fails closed on the evidence fence)', () => {
    it('should decode every named, decimal, and hex entity parse5 reads', async () => {
      const html = '<p>&amp; &lt; &gt; &quot; &#39; &#x27; &nbsp; &eacute; &#8364;</p>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result)[0]?.text).toBe("& < > \" ' '   é €");
    });

    it('should escape a literal entity-encoded </evidence> so it cannot close the prompt fence', async () => {
      const html = '<p>foo &lt;/evidence&gt; bar</p>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result)[0]?.text).toContain('&lt;/evidence');
    });

    // A raw `</evidence>` in body text is read by parse5 as a stray end tag and discarded before
    // it ever reaches a text node (verified against parse5's own parsing algorithm) — there is
    // nothing left for `sanitizeEvidenceText` to escape. The security property this parser must
    // hold either way: no emitted text contains an (open or close) `evidence` delimiter tag.
    it('should never emit an evidence delimiter tag for a raw </evidence> in body text', async () => {
      const html = '<p>foo </evidence> bar</p>';

      const result = await parser.parse(Buffer.from(html));

      for (const element of result.elements) {
        expect(element.text).not.toMatch(/<\/?evidence/i);
      }
    });
  });

  describe('parse — blocks', () => {
    it('should yield three blocks for unclosed <p>a<p>b<div>c', async () => {
      const result = await parser.parse(Buffer.from('<p>a<p>b<div>c'));

      const blocks = textBlocks(result);
      expect(blocks.map((block) => block.text)).toEqual(['a', 'b', 'c']);
      expect(blocks.map((block) => block.locator.blockIndex)).toEqual([0, 1, 2]);
    });

    it('should drive the heading trail with the truncate-then-push rule, across block interruptions', async () => {
      const html =
        '<h1>Market Overview</h1><p>intro</p><h2>Supply</h2><p>detail</p><h1>New Section</h1><p>after</p>';

      const result = await parser.parse(Buffer.from(html));

      const blocks = textBlocks(result);
      const byText = (text: string) => blocks.find((block) => block.text === text);
      expect(byText('intro')?.locator.headingPath).toEqual(['Market Overview']);
      expect(byText('Supply')?.locator.headingPath).toEqual(['Market Overview', 'Supply']);
      expect(byText('detail')?.locator.headingPath).toEqual(['Market Overview', 'Supply']);
      // A level-1 heading after a level-2 discards the level-2 (and deeper) entries.
      expect(byText('New Section')?.locator.headingPath).toEqual(['New Section']);
      expect(byText('after')?.locator.headingPath).toEqual(['New Section']);
    });

    it('should preserve whitespace verbatim inside <pre>', async () => {
      const html = '<pre>line one\n  indented\nline three</pre>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result)[0]?.text).toBe('line one\n  indented\nline three');
    });

    it('should collapse whitespace runs to one space outside <pre>', async () => {
      const html = '<p>a   b\n\tc</p>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result)[0]?.text).toBe('a b c');
    });

    it('should turn <br> into a newline', async () => {
      const html = '<p>line one<br>line two</p>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result)[0]?.text).toBe('line one\nline two');
    });

    it('should not silently drop loose text directly inside <body>, with no block-level ancestor', async () => {
      const html = '<body>loose text<p>para</p></body>';

      const result = await parser.parse(Buffer.from(html));

      expect(allText(result)).toContain('loose text');
      expect(allText(result)).toContain('para');
    });

    it('should give one block-level element its own block even when a nested block interrupts it', async () => {
      const html = '<div>before<p>middle</p>after</div>';

      const result = await parser.parse(Buffer.from(html));

      const blocks = textBlocks(result);
      // The div's own text is not contiguous in the source but is still one block, with the
      // nested <p> as its own separate block.
      expect(blocks.some((block) => block.text === 'middle')).toBe(true);
      expect(blocks.some((block) => block.text === 'beforeafter')).toBe(true);
    });

    it('should not emit a block for an element with no text of its own', async () => {
      const html = '<div><p></p></div>';

      const result = await parser.parse(Buffer.from(html));

      expect(result.elements).toEqual([]);
    });
  });

  describe('parse — tables', () => {
    it('should flatten a well-formed table to xlsx-cell elements with csv-style coordinates', async () => {
      const html =
        '<table><tr><td>Name</td><td>Amount</td></tr><tr><td>Acme</td><td>100</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('Name');
      expect(findCellElement(result, 'HTML-TABLE-1', 'B1')?.text).toBe('Amount');
      expect(findCellElement(result, 'HTML-TABLE-1', 'A2')?.text).toBe('Acme');
      expect(findCellElement(result, 'HTML-TABLE-1', 'B2')?.text).toBe('100');
      expect(textBlocks(result)).toEqual([]);
    });

    it('should skip an empty cell, like csv.parser.ts does', async () => {
      const html = '<table><tr><td>a</td><td></td></tr><tr><td>c</td><td>d</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(findCellElement(result, 'HTML-TABLE-1', 'B1')).toBeUndefined();
      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('a');
    });

    it('should give a colspan cell only its first column', async () => {
      const html =
        '<table><tr><td colspan="2">banner</td></tr><tr><td>a</td><td>b</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('banner');
      expect(findCellElement(result, 'HTML-TABLE-1', 'B1')).toBeUndefined();
      expect(findCellElement(result, 'HTML-TABLE-1', 'A2')?.text).toBe('a');
      expect(findCellElement(result, 'HTML-TABLE-1', 'B2')?.text).toBe('b');
    });

    it('should drop a script inside a table cell while the table still flattens around it', async () => {
      const CANARY = 'CELL_SCRIPT_CANARY';
      const html =
        `<table><tr><td>a<script>${CANARY}</script></td><td>b</td></tr>` +
        '<tr><td>c</td><td>d</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(allText(result)).not.toContain(CANARY);
      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('a');
      expect(findCellElement(result, 'HTML-TABLE-1', 'B2')?.text).toBe('d');
    });

    it('should not flatten a ragged table and should record the reduced-fidelity reason', async () => {
      const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(result.elements.some((element) => element.locator.kind === 'xlsx-cell')).toBe(false);
      expect(textBlocks(result).map((block) => block.text)).toEqual(['a\tb', 'c']);
      expect(result.reducedFidelityReasons).toEqual([
        expect.stringContaining('html-table-1-not-flattened'),
      ]);
    });

    it('should not flatten a table carrying a rowspan greater than one', async () => {
      const html = '<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(result.elements.some((element) => element.locator.kind === 'xlsx-cell')).toBe(false);
      expect(result.reducedFidelityReasons).toEqual([
        expect.stringContaining('html-table-1-not-flattened'),
      ]);
    });

    it('should not flatten a table nesting another table, while the nested table gets its own ordinal and flattens independently', async () => {
      const html =
        '<table><tr><td>A</td></tr><tr><td>' +
        '<table><tr><td>1</td></tr><tr><td>2</td></tr></table>' +
        '</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      // Outer table (ordinal 1) is disqualified by the nested table and falls back to row text —
      // its second row's own text is empty once the nested table's own cells are excluded from it.
      expect(textBlocks(result).map((block) => block.text)).toEqual(['A']);
      expect(result.reducedFidelityReasons).toEqual([
        expect.stringContaining('html-table-1-not-flattened'),
      ]);
      // Inner table (ordinal 2) is well-formed on its own and flattens independently.
      expect(findCellElement(result, 'HTML-TABLE-2', 'A1')?.text).toBe('1');
      expect(findCellElement(result, 'HTML-TABLE-2', 'A2')?.text).toBe('2');
    });

    it('should number two sibling tables HTML-TABLE-1 and HTML-TABLE-2 in document order', async () => {
      const html =
        '<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>' +
        '<table><tr><td>p</td><td>q</td></tr><tr><td>3</td><td>4</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('x');
      expect(findCellElement(result, 'HTML-TABLE-2', 'A1')?.text).toBe('p');
    });

    it("should exclude a hidden row from a table's row count and width check", async () => {
      const CANARY = 'HIDDEN_ROW_CANARY';
      const html =
        `<table><tr><td>A</td><td>B</td></tr><tr hidden><td>${CANARY}</td><td>${CANARY}</td></tr>` +
        '<tr><td>C</td><td>D</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(allText(result)).not.toContain(CANARY);
      expect(findCellElement(result, 'HTML-TABLE-1', 'A1')?.text).toBe('A');
      // With the hidden row excluded, "C"/"D" become the table's second physical row.
      expect(findCellElement(result, 'HTML-TABLE-1', 'A2')?.text).toBe('C');
    });

    it("should drop a well-formed table's caption", async () => {
      const html =
        '<table><caption>Rent Roll</caption><tr><td>a</td><td>b</td></tr>' +
        '<tr><td>c</td><td>d</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(allText(result)).not.toContain('Rent Roll');
    });

    it("should emit a not-well-formed table's caption as its own text-block", async () => {
      const html =
        '<table><caption>Ragged Table</caption><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result).some((block) => block.text === 'Ragged Table')).toBe(true);
    });
  });

  describe('parse — capacity bounds (fail closed)', () => {
    it('should refuse a document one byte over HTML_MAX_BYTES, naming the cap', async () => {
      const oversized = Buffer.concat([Buffer.from(`<p>${'a'.repeat(HTML_MAX_BYTES)}</p>`)]);
      expect(oversized.length).toBeGreaterThan(HTML_MAX_BYTES);

      await expect(parser.parse(oversized)).rejects.toBeInstanceOf(MalformedHtmlException);
      await expect(parser.parse(oversized)).rejects.toThrow(new RegExp(`${HTML_MAX_BYTES}`));
    });

    it.each([
      ['script', 'script'],
      ['style', 'style'],
      ['textarea', 'textarea'],
      ['title', 'title'],
      ['xmp', 'xmp'],
      ['noembed', 'noembed'],
      ['noframes', 'noframes'],
      ['noscript', 'noscript'],
      ['iframe', 'iframe'],
    ])(
      'should refuse an unterminated <%s> before it can swallow the rest of the document',
      async (_label, tag) => {
        const html = `<p>visible</p><${tag}>never closes`;

        await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(
          MalformedHtmlException,
        );
      },
    );

    it('should refuse a document containing <plaintext>, which the grammar never lets close', async () => {
      const html = '<p>visible</p><plaintext>content</plaintext><p>never reached</p>';

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
    });

    it('should still parse a document whose raw-text elements are properly terminated', async () => {
      const html = '<p>a</p><script>1;</script><style>.x{}</style><p>b</p>';

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result).map((block) => block.text)).toEqual(['a', 'b']);
    });

    it('should refuse a document opening more than HTML_MAX_EMITTED_ELEMENTS blocks', async () => {
      const html = Array.from(
        { length: HTML_MAX_EMITTED_ELEMENTS + 1 },
        (_unused, index) => `<p>${index}</p>`,
      ).join('');

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
    });

    it('should refuse non-whitespace input that yields zero elements', async () => {
      const html = '<div hidden>invisible</div><script>1;</script>';

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
    });

    it('should return zero elements for a blank document, without refusing', async () => {
      const result = await parser.parse(Buffer.from('   \n\t  '));

      expect(result.elements).toEqual([]);
    });

    // A document this deep is small enough to clear every other cap, and costs `parse5` minutes of
    // synchronous CPU if it ever reaches it — more than the ingest activity's own timeout. The
    // refusal has to come from the depth scan, which runs before `parseHtml`, so these cases are
    // also what keeps the suite fast enough to need no timeout override.
    it('should refuse a document nested past HTML_MAX_NESTING_DEPTH, naming the cap', async () => {
      const depth = HTML_MAX_NESTING_DEPTH + 1;
      const html = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
      await expect(parser.parse(Buffer.from(html))).rejects.toThrow(
        new RegExp(`${HTML_MAX_NESTING_DEPTH}`),
      );
    });

    it('should refuse deep nesting written with a self-closing slash, which HTML does not honour', async () => {
      // `<div/>` opens a div outside foreign content. A depth scan that read the slash as a close
      // would see depth zero here and hand `parse5` the same document the case above refuses.
      const html = '<div/>'.repeat(HTML_MAX_NESTING_DEPTH + 1) + 'x';

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
    });

    it('should not count stray closing tags as credit against later nesting', async () => {
      // Balance clamped at zero: without the clamp these closes would pay for the nesting after
      // them, and a document over the cap would parse.
      const depth = HTML_MAX_NESTING_DEPTH + 1;
      const html = '</div>'.repeat(depth) + '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);

      await expect(parser.parse(Buffer.from(html))).rejects.toBeInstanceOf(MalformedHtmlException);
    });

    it('should parse a shallow document carrying thousands of void elements', async () => {
      // Void elements never close, so counting them as opens would refuse this ordinary page.
      const html = `<p>before${'<img src="x.png"><wbr>'.repeat(5_000)}after</p>`;

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result).map((block) => block.text)).toEqual(['beforeafter']);
    });

    // Deep enough to prove the walk is iterative rather than recursive — a recursive walk overflows
    // the stack a decimal order of magnitude below this — but not at `HTML_MAX_NESTING_DEPTH`
    // itself. That bound is calibrated against a degenerate unclosed chain, and building one at the
    // bound would cost `parse5` tens of seconds inside a unit test to prove a property this depth
    // already proves.
    it('should parse a deeply nested document without a stack overflow', async () => {
      const depth = 5_000;
      const html = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);

      const result = await parser.parse(Buffer.from(html));

      expect(textBlocks(result).map((block) => block.text)).toEqual(['x']);
    });

    it('should parse an exactly-HTML_MAX_BYTES document of 2,000 paragraphs into at most 2,000 elements', async () => {
      const paragraphOpen = '<p>';
      const paragraphClose = '</p>';
      const paragraphCount = 2_000;
      const overhead = (paragraphOpen.length + paragraphClose.length) * paragraphCount;
      const fillerLength = Math.floor((HTML_MAX_BYTES - overhead) / paragraphCount);
      const filler = 'x'.repeat(fillerLength);
      const paragraphs: string[] = [];
      for (let index = 0; index < paragraphCount; index += 1) {
        paragraphs.push(`${paragraphOpen}${filler}${paragraphClose}`);
      }
      let html = paragraphs.join('');
      // Pad up to exactly HTML_MAX_BYTES with more filler inside the final paragraph so the
      // fixture is exactly at the cap rather than merely under it.
      const shortfall = HTML_MAX_BYTES - Buffer.byteLength(html);
      if (shortfall > 0) {
        html = html.slice(0, -paragraphClose.length) + 'y'.repeat(shortfall) + paragraphClose;
      }
      expect(Buffer.byteLength(html)).toBe(HTML_MAX_BYTES);

      const result = await parser.parse(Buffer.from(html));

      expect(result.elements.length).toBeLessThanOrEqual(2_000);
      expect(result.elements.length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe('parse — encoding', () => {
    it('should decode a windows-1252 document and record the reduced-fidelity reason', async () => {
      // "<p>Tenant's Notes</p>" with the windows-1252 right-single-quote byte (0x92) standing in
      // for the apostrophe — not a valid UTF-8 sequence on its own.
      const buffer = Buffer.from([
        ...Buffer.from('<p>Tenant'),
        0x92,
        ...Buffer.from('s Notes</p>'),
      ]);

      const result = await parser.parse(buffer);

      expect(textBlocks(result)[0]?.text).toBe('Tenant’s Notes');
      expect(result.reducedFidelityReasons).toEqual([expect.stringContaining('windows-1252')]);
    });

    it('should report no reduced-fidelity reason for an ordinary UTF-8 document', async () => {
      const result = await parser.parse(Buffer.from('<p>Tenant’s Notes</p>', 'utf8'));

      expect(result.reducedFidelityReasons).toBeUndefined();
    });
  });

  describe('parse — extractorVersion and determinism', () => {
    it('should stamp extractorVersion on the document and on every locator', async () => {
      const result = await parser.parse(
        Buffer.from(
          '<p>a</p><table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>',
        ),
      );

      expect(result.extractorVersion).toBe('html-parse5-1');
      expect(result.elements.length).toBeGreaterThan(0);
      for (const element of result.elements) {
        expect(element.locator.extractorVersion).toBe('html-parse5-1');
      }
    });

    it('should parse the same document identically on repeat calls', async () => {
      const html =
        '<h1>Title</h1><p>a</p><table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>';

      const first = await parser.parse(Buffer.from(html));
      const second = await parser.parse(Buffer.from(html));

      expect(first).toEqual(second);
    });
  });

  describe('parse — sanitization', () => {
    it('should apply sanitizeEvidenceText to block text', async () => {
      const result = await parser.parse(Buffer.from('<p>plain text</p>'));

      expect(textBlocks(result)[0]?.text).toBe(sanitizeEvidenceText('plain text'));
    });
  });
});
