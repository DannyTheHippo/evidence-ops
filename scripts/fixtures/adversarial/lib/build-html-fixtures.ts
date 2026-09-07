import { HTML_MAX_BYTES } from '../../../../src/features/evidence/ingestion/parsers/html.parser';

/**
 * The `.html` half of the adversarial corpus: seven committed shapes exercising `html.parser.ts`'s
 * drop, recovery, and fail-closed paths against realistic rent-roll and ledger content — plus the
 * two byte-cap fixtures, built in memory only.
 *
 * Every on-disk buffer is UTF-8 text assembled from a fixed template, so two generator runs produce
 * identical bytes. `buildTwentyMebibyteHtml` and `buildOversizeHtml` are never written to
 * `fixtures/adversarial`, mirroring `build-huge-xlsx.ts`: their point is the byte cap they sit at or
 * cross, not bytes worth committing.
 */

function html(body: string): Buffer {
  return Buffer.from(body, 'utf8');
}

/** Wraps one paragraph in `depth` levels of `<div>`, past `HTML_MAX_NESTING_DEPTH` at the default
 *  depth — this refuses at the depth scan before `parse5` ever runs, rather than parsing into a
 *  deeply nested but otherwise ordinary document. */
export function buildNestedTagsHtml(depth = 5_000): Buffer {
  return html(
    `${'<div>'.repeat(depth)}<p>Deeply nested paragraph text.</p>${'</div>'.repeat(depth)}`,
  );
}

/** `<li>` items and a trailing `<p>` with no closing tags — ordinary HTML5 parse-error recovery (a
 *  `<li>` auto-closes the previous one; a block-level start tag auto-closes an open `<p>`), not a
 *  refusal: every item still becomes its own block. */
export function buildUnclosedTagsHtml(): Buffer {
  return html(
    [
      '<ul>',
      '<li>Suite A-100 — $1,200/mo',
      '<li>Suite A-101 — $1,450/mo',
      '<li>Suite A-102 — $1,600/mo',
      '</ul>',
      '<p>Figures above are unaudited.',
    ].join('\n'),
  );
}

/** `<script>` with no closing tag at all — refuses before its bytes could swallow anything after
 *  it, on a realistic analytics-snippet shape rather than the parser spec's own minimal case. */
export function buildUnterminatedScriptHtml(): Buffer {
  return html(
    [
      '<p>Visible summary above the broken script.</p>',
      '<script>',
      'window.dataLayer = window.dataLayer || [];',
      'trackPageview("kestrel-point-ledger");',
    ].join('\n'),
  );
}

/** Named, decimal, and hex character references, `&nbsp;`, and a literal `&lt;/evidence&gt;` that
 *  decodes to `</evidence>` — the citation-fence escape `sanitizeEvidenceText` re-escapes on its
 *  way out. */
export function buildEntitiesHtml(): Buffer {
  return html(
    [
      '<p>&amp; &lt; &gt; &quot; &#39; &#x27; &nbsp; &eacute; &#8364;</p>',
      '<p>Citation guard check: &lt;/evidence&gt; must never close the fence.</p>',
    ].join('\n'),
  );
}

/** A well-formed 3x3 table (uniform width, no rowspan, no nested table) carrying a `<script>` and
 *  a `<style>` inside two of its cells and one `hidden` row — the table still flattens, the script
 *  and style contribute no text, and the hidden row never reaches `table.rows`, so it plays no part
 *  in the width check that decides well-formedness. */
export function buildScriptInsideTableHtml(): Buffer {
  return html(
    [
      '<table>',
      '<tr><td>Suite</td><td>Rent</td><td>Status</td></tr>',
      '<tr><td>A-100<script>trackView("A-100");</script></td><td>1,200</td><td>Occupied</td></tr>',
      '<tr hidden><td>INTERNAL</td><td>0</td><td>Do not display</td></tr>',
      '<tr><td>A-101<style>.rent-table td { color: red; }</style></td><td>1,450</td><td>Vacant</td></tr>',
      '</table>',
    ].join('\n'),
  );
}

/** One visible paragraph beside every hidden-element signal the parser honours — the `hidden`
 *  attribute, `display:none`, `visibility:hidden`, and `input[type=hidden]` — so the visible text
 *  keeps the zero-element bound from tripping while every hidden signal is proven dropped. */
export function buildHiddenElementsHtml(): Buffer {
  return html(
    [
      '<p>Visible ledger summary for Kestrel Point.</p>',
      '<div hidden>Hidden via the hidden attribute.</div>',
      '<div style="display: none;">Hidden via display:none.</div>',
      '<div style="visibility:hidden">Hidden via visibility:hidden.</div>',
      '<input type="hidden" value="Hidden via input type=hidden.">',
    ].join('\n'),
  );
}

/** A rent-roll style header plus five data rows, uniform width, no rowspan, no nested table — the
 *  well-formed shape that flattens to `xlsx-cell` elements. `colspan` appears only on the caption,
 *  which is not itself a row and so plays no part in the width check that decides
 *  well-formedness. */
export function buildWellFormedTableHtml(): Buffer {
  return html(
    [
      '<table>',
      '<caption colspan="3">Kestrel Point Rent Roll — Q3 2026</caption>',
      '<tr><th>Suite</th><th>Tenant</th><th>Rent</th></tr>',
      '<tr><td>A-100</td><td>Aldercrest Consulting</td><td>1,200</td></tr>',
      '<tr><td>A-101</td><td>Meridian Facilities</td><td>1,450</td></tr>',
      '<tr><td>A-102</td><td>Northgate Partners</td><td>1,600</td></tr>',
      '<tr><td>A-103</td><td>Fenwick Holdings</td><td>1,750</td></tr>',
      '<tr><td>A-104</td><td>Vacant</td><td>0</td></tr>',
      '</table>',
    ].join('\n'),
  );
}

/** Uneven row widths and a `rowspan` greater than one — either alone disqualifies well-formedness;
 *  together they still fall back to one `text-block` per row with a single recorded reason. */
export function buildRaggedTableHtml(): Buffer {
  return html(
    [
      '<table>',
      '<tr><td rowspan="2">Suite A-100</td><td>1,200</td></tr>',
      '<tr><td>Occupied</td><td>Q3 2026</td></tr>',
      '<tr><td>Suite A-101</td></tr>',
      '</table>',
    ].join('\n'),
  );
}

const PARAGRAPH_OPEN = '<p>';
const PARAGRAPH_CLOSE = '</p>';
const TWENTY_MEBIBYTE_PARAGRAPH_COUNT = 2_000;

/** Exactly `HTML_MAX_BYTES` bytes across 2,000 paragraphs — at the byte cap rather than merely
 *  under it, so it proves the cap admits a real-sized document rather than only a small one.
 *  In-memory only: multi-megabyte, and regenerated fresh by whichever spec needs it. */
export function buildTwentyMebibyteHtml(): Buffer {
  const overhead =
    (PARAGRAPH_OPEN.length + PARAGRAPH_CLOSE.length) * TWENTY_MEBIBYTE_PARAGRAPH_COUNT;
  const fillerLength = Math.floor((HTML_MAX_BYTES - overhead) / TWENTY_MEBIBYTE_PARAGRAPH_COUNT);
  const filler = 'x'.repeat(fillerLength);
  const paragraphs: string[] = [];
  for (let index = 0; index < TWENTY_MEBIBYTE_PARAGRAPH_COUNT; index += 1) {
    paragraphs.push(`${PARAGRAPH_OPEN}${filler}${PARAGRAPH_CLOSE}`);
  }
  let content = paragraphs.join('');
  // Pad the final paragraph up to exactly HTML_MAX_BYTES, mirroring the same shortfall-padding
  // rule html.parser.spec.ts uses for its own exactly-at-the-cap fixture.
  const shortfall = HTML_MAX_BYTES - Buffer.byteLength(content);
  if (shortfall > 0) {
    content = content.slice(0, -PARAGRAPH_CLOSE.length) + 'y'.repeat(shortfall) + PARAGRAPH_CLOSE;
  }
  return html(content);
}

/** `HTML_MAX_BYTES + 1` bytes — one byte over the cap this parser checks before it ever decodes or
 *  parses the buffer, so the content need not be valid HTML at all. In-memory only, for the same
 *  reason as {@link buildTwentyMebibyteHtml}. */
export function buildOversizeHtml(): Buffer {
  return Buffer.alloc(HTML_MAX_BYTES + 1, 0x61);
}
