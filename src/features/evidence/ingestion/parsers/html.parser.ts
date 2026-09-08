import { html, parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';
import type {
  TextBlockLocator,
  XlsxCellLocator,
} from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { decodeTextBuffer, encodingFidelityReasons } from '../decode-text-buffer';
import { MalformedHtmlException } from '../exceptions/ingestion.exception';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';
import { columnLetter } from './csv.parser';

const HTML_MIME_TYPE = 'text/html';

// Bump whenever a change here could shift the block/cell coordinates a stored citation points at.
const EXTRACTOR_VERSION = 'html-parse5-1';

/**
 * Fails CLOSED, as a capacity limit: an upload past this is refused before `parse5` ever sees it.
 * Independent of, and tighter than, the upload gate's own `MAX_FILE_SIZE_BYTES` (50 MiB) — an
 * accepted upload can still be refused here, the same relationship `xlsx.parser.ts`'s worksheet
 * budget carries to the archive budget it sits under.
 *
 * Sized against real filings: the largest 10-K measured is 20.27 MiB, and byte count is not what
 * drives parse cost — a 15 MiB filing parses in well under a second, while a 0.5 MiB degenerate
 * chain costs tens of seconds, which {@link HTML_MAX_NESTING_DEPTH} is what bounds. See
 * `docs/adr/0029`'s amendment.
 */
export const HTML_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Fails CLOSED, as a capacity limit on this parser's own output and the downstream chunking cost
 * of one document — the xlsx precedent (`MAX_TOTAL_EMITTED_ELEMENTS`). Counted against every block,
 * heading, table cell and table caption this parser opens rather than every one it emits: an
 * untrusted document can open far more blocks than it ends up keeping, so counting at open is the
 * conservative approximation of the output being bounded. It is not a bound on parsing cost —
 * this count runs during the tree walk, which begins only once `parse5` has already returned; the
 * cost of reaching that point is bounded by {@link HTML_MAX_NESTING_DEPTH} instead.
 *
 * Sized against real filings rather than synthetic fixtures: a REIT 10-K's financial tables open
 * tens of thousands of cells, reaching ~106,000 block-level elements in the largest measured, so a
 * lower cap refuses ordinary annual reports. See `docs/adr/0029`'s amendment.
 */
export const HTML_MAX_EMITTED_ELEMENTS = 150_000;

/**
 * Fails CLOSED, checked against the decoded text before `parse5` ever sees it. `parse5`'s own parse
 * cost grows quadratically in the depth of an *unclosed* element chain while staying linear in tag
 * count, so a small file of deeply nested unclosed tags costs orders of magnitude more than a large
 * flat one. No budget this parser checks during its own tree walk can bound that, because the walk
 * runs only after `parseHtml` returns — this is the only guard that runs in time.
 *
 * The bound is calibrated against the degenerate shape, not against real documents, because
 * `checkNestingDepth` counts cumulative unclosed opens rather than `parse5`'s own stack depth: it
 * knows nothing of implicit closing, so a table-heavy filing whose `<td>`/`<tr>`/`<p>` close
 * implicitly scores far higher here than it costs to parse. Real SEC filings reach a scanned depth
 * of ~50,000 and parse in well under a second; a single unclosed chain at the same scanned depth
 * costs tens of seconds. This sits above the former and below the point where the latter would
 * approach the ingest activity's own timeout, so it admits real documents and still refuses the
 * shape it exists to refuse. Measurements: `docs/adr/0029-html-parser-nesting-depth-bound.md`.
 */
export const HTML_MAX_NESTING_DEPTH = 60_000;

/**
 * The void elements, excluded from the depth scan because they never close — counting them as opens
 * would refuse an ordinary page carrying a few thousand `<br>` or `<img>`. Every other tag counts,
 * including one written `<div/>`: outside foreign content HTML has no self-closing syntax, so that
 * opens a `div` rather than closing it, and a scanner that honoured the slash would read depth zero
 * from a document `parse5` nests a hundred thousand levels deep.
 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * Dropped entirely, never contributing text: the six the plan names (`script`, `style`, `template`,
 * `noscript`, `iframe`, `object`, `embed`) plus `head`, and an extension beyond that list —
 * `textarea`, `title`, `xmp`, `noembed`, `noframes`, `plaintext` — every other tag whose content
 * WHATWG's tokenizer reads in a raw-text or RCDATA state. None of the extension six is genuine
 * document prose (a page title, a form's default value, or legacy fallback rendering no modern
 * reader sees), and the same "an unterminated one swallows the rest of the document" hazard the
 * plan states for `script`/`style` applies to every tag in this set — see
 * {@link RAW_TEXT_SWALLOWING_TAGS}.
 */
const DROP_TAGS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'head',
  'textarea',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
]);

/**
 * Every tag whose content the tokenizer reads in a raw-text, RCDATA, or (`plaintext`) permanently
 * raw state — checked for a missing `sourceCodeLocation.endTag` regardless of whether the tag is
 * also in {@link DROP_TAGS}: an unterminated one does not merely fail to close, it consumes every
 * remaining byte of the document as its own content, so refusing here is what stops a hidden
 * `<script>` (say) from silently swallowing the visible paragraphs that were meant to follow it.
 * `plaintext` has no closing tag in the grammar at all, so its mere presence always refuses.
 */
const RAW_TEXT_SWALLOWING_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'noscript',
  'iframe',
  'plaintext',
]);

/**
 * One `text-block` per element in this set, in document order, when not suppressed and not inside
 * a table cell or caption (whose own text is flat-accumulated instead — see `openElement`'s
 * `insideCellLikeContext` branch). `body` is not in the plan's own enumeration; it is added so
 * loose text with no other block-level ancestor (`<body>text<p>…` — legal HTML) is not silently
 * dropped, the same failure class this parser exists to avoid.
 */
const BLOCK_LEVEL_TAGS = new Set([
  'p',
  'div',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'dt',
  'dd',
  'section',
  'article',
  'header',
  'footer',
  'figcaption',
  'body',
]);

const HEADING_LEVELS: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const HIDDEN_STYLE_PATTERN = /display\s*:\s*none|visibility\s*:\s*hidden/i;

/** Excel's own limit is 16,384; this only needs to keep one hostile `colspan` from dominating a
 * row-width sum, not to model a real spreadsheet's own bound. */
const MAX_COLSPAN = 1000;

type TreeNode = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;
type ElementNode = DefaultTreeAdapterTypes.Element;

/** Accumulates the text directly owned by one block, table cell, or caption — never a nested
 * block-level descendant's own text, which accumulates into its own accumulator instead. */
interface TextAccumulator {
  readonly parts: string[];
  readonly isPre: boolean;
}

/** Collapses runs of layout whitespace to a single space, deliberately excluding U+00A0. A
 * non-breaking space is content the document chose, not the incidental indentation of its markup —
 * `\s` matches it, so the obvious `/\s+/g` silently rewrites `&nbsp;&nbsp;` to one ordinary space
 * and a citation quoting that text no longer matches the bytes stored at parse time. */
function collapseWhitespace(text: string): string {
  return text.replace(/[^\S\u00a0]+/g, ' ');
}

function appendText(accumulator: TextAccumulator, raw: string): void {
  accumulator.parts.push(accumulator.isPre ? raw : collapseWhitespace(raw));
}

/** Appends text exactly as given, bypassing `collapseWhitespace`. `<br>` is the only caller: the
 * newline it contributes is structure the markup asked for, and routing it through `appendText`
 * would collapse it back into the space it was meant to replace. */
function appendVerbatim(accumulator: TextAccumulator, raw: string): void {
  accumulator.parts.push(raw);
}

/** Parts are joined with `''` because each was normalized as it arrived — a `<br>`'s `\n` reaches
 * `parts` verbatim and survives to here. */
function finalizeAccumulatorText(accumulator: TextAccumulator): string {
  return accumulator.parts.join('').trim();
}

/** A `text-block` this parser is building. Its position in `blockRecords` (assigned when the
 * block opens) is what `blockIndex` reflects once empty records are filtered out at the end —
 * open order, not close order, so a block interrupted by a nested block (`<div>before<p>..</p>
 * after</div>`) still gets one blockIndex for its own (non-contiguous) text. `text` and
 * `headingPath` are filled in when the block closes, once its own subtree has been fully walked. */
interface BlockRecord {
  readonly accumulator: TextAccumulator;
  text: string;
  headingPath: string[];
}

interface Cell {
  text: string;
  readonly colspan: number;
}

interface Row {
  readonly cells: Cell[];
}

/** One `<table>`, tracked from the moment its start tag is seen (so a nested table gets its own
 * ordinal immediately, before the outer table's own well-formedness is known) until its own close,
 * where well-formedness is decided and its elements are produced. */
interface TableAccumulator {
  readonly ordinal: number;
  readonly rows: Row[];
  readonly captionAccumulators: TextAccumulator[];
  hasNestedTable: boolean;
  hasDisqualifyingRowspan: boolean;
}

/** Mutable state threaded through the whole walk — one instance per `parse()` call, never reused
 * across documents. */
interface WalkState {
  openedRecordCount: number;
  readonly blockRecords: BlockRecord[];
  readonly headingTrail: string[];
  readonly tableElementBatches: ParsedElement[][];
  readonly reducedFidelityReasons: string[];
  nextTableOrdinal: number;
  /** True once any text node anywhere in the document — suppressed or not — carried non-whitespace
   * content. Distinct from the raw decoded buffer being non-blank: a document built entirely of
   * tags with no text at all (`<div><p></p></div>`) is not evidence that something got dropped, but
   * a document whose only text lived inside a hidden or excluded element is. */
  sawNonWhitespaceText: boolean;
}

/** Fails CLOSED: refuses the whole document once the running count of blocks, headings, table cells
 * and captions this walk has opened exceeds {@link HTML_MAX_EMITTED_ELEMENTS}. Every one of them is
 * counted the moment it opens, before its own text is known, so the refusal lands on the document
 * that builds the structure rather than on the subset of it that survives to be emitted. A wrapper
 * chain deep enough to exhaust this budget on structure alone is refused earlier and more cheaply
 * by {@link HTML_MAX_NESTING_DEPTH}, before `parse5` runs at all. */
/** Fails CLOSED past {@link HTML_MAX_NESTING_DEPTH}. A deliberate over-approximation of the depth
 * `parse5` goes on to build, not a tokenizer: it reads no raw-text or RCDATA state, so tags written
 * inside a `<script>` body count, and it knows nothing of auto-closing, so a run of sibling `<p>` or
 * `<li>` counts as ever deeper nesting. Both err toward refusing, which is the safe direction —
 * what the guard needs is a floor on `parse5`'s depth, never an over-estimate of it, and the one
 * place it reads lower is the wrappers `parse5` inserts on its own (`<tbody>` inside every table).
 * The running balance clamps at zero so stray closing tags cannot bank credit against later opens:
 * without that, a thousand `</div>` in a comment would pay for a thousand real levels of nesting. */
function checkNestingDepth(text: string): void {
  // Only simple, non-nested quantifiers — the guard against a super-linear parse must not itself
  // backtrack on hostile input.
  const tagPattern = /<(\/?)([a-zA-Z][^\s/>]*)/g;
  let depth = 0;

  for (let match = tagPattern.exec(text); match !== null; match = tagPattern.exec(text)) {
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (VOID_ELEMENTS.has(match[2].toLowerCase())) {
      continue;
    }
    depth += 1;
    if (depth > HTML_MAX_NESTING_DEPTH) {
      throw new MalformedHtmlException(
        `Document nests elements more than ${HTML_MAX_NESTING_DEPTH} levels deep, exceeding the ` +
          'depth this parser supports — split the page or trim it to a smaller extract',
      );
    }
  }
}

function checkElementBudget(state: WalkState): void {
  state.openedRecordCount += 1;
  if (state.openedRecordCount > HTML_MAX_EMITTED_ELEMENTS) {
    throw new MalformedHtmlException(
      `Document opens more than ${HTML_MAX_EMITTED_ELEMENTS} blocks, headings, or table cells, ` +
        'exceeding the size this parser supports — split the page or trim it to a smaller extract',
    );
  }
}

function getAttribute(element: ElementNode, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

/** Fails CLOSED toward dropping: any of these signals is enough to exclude an element and its
 * whole subtree from extraction, on the same "hide it" intent a reader's own browser honours. */
function isHiddenElement(element: ElementNode): boolean {
  if (element.attrs.some((attribute) => attribute.name === 'hidden')) {
    return true;
  }
  const style = getAttribute(element, 'style');
  if (style !== undefined && HIDDEN_STYLE_PATTERN.test(style)) {
    return true;
  }
  if (
    element.tagName === 'input' &&
    (getAttribute(element, 'type') ?? '').toLowerCase() === 'hidden'
  ) {
    return true;
  }
  return false;
}

/** Non-numeric, zero, negative, or absent all read as the HTML default of one column; a huge
 * declared span is clamped rather than trusted, so one hostile cell cannot dominate a row's width
 * sum ({@link MAX_COLSPAN}). Attacker-controlled, so every branch is a deliberate default, never a
 * thrown parse error over a string this parser does not otherwise care to validate. */
function parseColspan(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return 1;
  }
  return Math.min(value, MAX_COLSPAN);
}

/** `rowspan="0"` means "to the end of the section" in HTML — not one row either way — so it
 * disqualifies a table from flattening exactly as any `rowspan > 1` does. */
function hasDisqualifyingRowspan(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed === '0') {
    return true;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 1;
}

/**
 * Decides whether `table` flattens to `xlsx-cell`s or falls back to one `text-block` per row.
 *
 * Well-formed requires at least two rows, an identical colspan-expanded width across every row,
 * no `rowspan` greater than one anywhere, and no table nested inside it — any one of those absent
 * makes a coordinate this parser would emit an outright guess, which fails CLOSED to the row-text
 * fallback instead.
 */
function isTableWellFormed(table: TableAccumulator): boolean {
  if (table.rows.length < 2 || table.hasNestedTable || table.hasDisqualifyingRowspan) {
    return false;
  }
  const widths = table.rows.map((row) =>
    row.cells.reduce((total, cell) => total + cell.colspan, 0),
  );
  return widths.every((width) => width === widths[0]);
}

/**
 * Finalizes one table's cells and captions into its `ParsedElement`s, and reports its outcome
 * onto `state`. Well-formed: one `xlsx-cell` per non-empty cell, `sheetName: 'HTML-TABLE-<n>'`,
 * `cell` addressed by the cell's own first (colspan-occupied) column and its 1-based row across
 * every section in document order — the csv precedent for both an empty-cell skip and a merged
 * cell occupying only its first column — and nothing else: a well-formed table's caption is
 * dropped along with everything else the plan excludes from a flattened table's output. Not
 * well-formed: one `text-block` per row, that row's cells joined by a tab, plus every caption as
 * its own ordinary `text-block` — captions are never part of a row and so never join one — and a
 * `html-table-<n>-not-flattened: <reason>` entry in `reducedFidelityReasons`.
 */
function finalizeTable(
  table: TableAccumulator,
  headingPath: readonly string[],
  state: WalkState,
): void {
  const elements: ParsedElement[] = [];

  if (isTableWellFormed(table)) {
    table.rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row.cells) {
        const text = cell.text.trim();
        if (text !== '') {
          const locator: XlsxCellLocator = {
            kind: 'xlsx-cell',
            sheetName: `HTML-TABLE-${table.ordinal}`,
            cell: `${columnLetter(column)}${rowIndex + 1}`,
            extractorVersion: EXTRACTOR_VERSION,
          };
          elements.push({ text: sanitizeEvidenceText(text), locator, headingPath: [] });
        }
        column += cell.colspan;
      }
    });
  } else {
    let blockIndex = 0;
    table.rows.forEach((row) => {
      const rowText = row.cells
        .map((cell) => cell.text.trim())
        .join('\t')
        .trim();
      if (rowText === '') {
        return;
      }
      const locator: TextBlockLocator = {
        kind: 'text-block',
        blockIndex,
        headingPath: [...headingPath],
        extractorVersion: EXTRACTOR_VERSION,
      };
      elements.push({
        text: sanitizeEvidenceText(rowText),
        locator,
        headingPath: [...headingPath],
      });
      blockIndex += 1;
    });
    for (const captionAccumulator of table.captionAccumulators) {
      const captionText = finalizeAccumulatorText(captionAccumulator);
      if (captionText === '') {
        continue;
      }
      const locator: TextBlockLocator = {
        kind: 'text-block',
        blockIndex,
        headingPath: [...headingPath],
        extractorVersion: EXTRACTOR_VERSION,
      };
      elements.push({
        text: sanitizeEvidenceText(captionText),
        locator,
        headingPath: [...headingPath],
      });
      blockIndex += 1;
    }
    state.reducedFidelityReasons.push(
      `html-table-${table.ordinal}-not-flattened: table is not two or more rows of equal, ` +
        'unspanned width with no nested table, so its rows are emitted as text instead of cells',
    );
  }

  state.tableElementBatches.push(elements);
}

/** What the parent frame hands down to each child during the walk. */
interface WalkContext {
  readonly suppressed: boolean;
  /** The nearest enclosing block, table cell, or caption's accumulator — `undefined` only before
   * any such container has ever opened, which in practice is never, since `body` always opens
   * one. Text nodes with no accumulator (found only outside `<body>`, e.g. inside `<head>`, which
   * is already suppressed) are simply not accumulated anywhere. */
  readonly accumulator: TextAccumulator | undefined;
  /** True inside a table cell or caption: nested tags there never open their own block — a cell's
   * text is one flat run regardless of markup inside it, matching `csv.parser.ts`'s one-value-per-
   * cell model rather than this parser's own per-tag block splitting. */
  readonly insideCellLikeContext: boolean;
  /** The nearest enclosing table, for nested-table detection and row/cell attribution — distinct
   * from `insideCellLikeContext`, which only widens once actually inside a cell or caption. */
  readonly table: TableAccumulator | undefined;
  /** The row currently accumulating cells, present only directly inside a `<tr>`. */
  readonly row: Row | undefined;
}

/** What a frame itself owns, resolved when its own children have all been walked (post-order). */
type OwnedKind =
  | { readonly type: 'none' }
  | { readonly type: 'block'; readonly record: BlockRecord; readonly headingLevel?: number }
  | { readonly type: 'table'; readonly table: TableAccumulator; readonly headingPath: string[] }
  | { readonly type: 'row'; readonly row: Row; readonly table: TableAccumulator }
  | { readonly type: 'cell'; readonly accumulator: TextAccumulator; readonly cell: Cell }
  | {
      readonly type: 'caption';
      readonly accumulator: TextAccumulator;
      readonly table: TableAccumulator;
    };

type StackItem =
  | { readonly phase: 'open'; readonly node: TreeNode; readonly context: WalkContext }
  | { readonly phase: 'close'; readonly owned: OwnedKind };

/**
 * Resolves what `element` opens: whether it is suppressed, whether it starts a new block/cell/
 * caption/table/row, and what its children should inherit. Never recurses and never mutates
 * `state` beyond the budget check and (for a heading) the heading trail — the caller is the one
 * iterative loop in {@link HtmlParser.parse}.
 */
function openElement(
  element: ElementNode,
  parentContext: WalkContext,
  state: WalkState,
): { readonly context: WalkContext; readonly owned: OwnedKind } {
  const tagName = element.namespaceURI === html.NS.HTML ? element.tagName : '';

  if (RAW_TEXT_SWALLOWING_TAGS.has(tagName) && element.sourceCodeLocation?.endTag === undefined) {
    throw new MalformedHtmlException(
      `<${tagName}> has no closing tag — an unterminated raw-text element would otherwise ` +
        'swallow every byte after it as its own content',
    );
  }

  const suppressed =
    parentContext.suppressed ||
    DROP_TAGS.has(tagName) ||
    (tagName !== '' && isHiddenElement(element));

  if (suppressed) {
    return {
      context: { ...parentContext, suppressed: true },
      owned: { type: 'none' },
    };
  }

  // Checked before the cell/caption bypass below: a table nested inside a cell must still be
  // recognized as its own table (its own ordinal, evaluated independently at its own close, and
  // disqualifying the enclosing table via `hasNestedTable`) rather than being swallowed as more of
  // the cell's own flat text.
  if (tagName === 'table') {
    state.nextTableOrdinal += 1;
    const table: TableAccumulator = {
      ordinal: state.nextTableOrdinal,
      rows: [],
      captionAccumulators: [],
      hasNestedTable: false,
      hasDisqualifyingRowspan: false,
    };
    if (parentContext.table !== undefined) {
      parentContext.table.hasNestedTable = true;
    }
    return {
      // Resets `insideCellLikeContext`/`accumulator`: a table's own row/cell structure is never
      // part of whichever outer cell or caption happens to contain it, however deeply nested.
      context: {
        ...parentContext,
        table,
        row: undefined,
        insideCellLikeContext: false,
        accumulator: undefined,
      },
      owned: { type: 'table', table, headingPath: [...state.headingTrail] },
    };
  }

  // A cell or caption's own content is one flat text run: nested tags (including an ordinarily
  // block-level one, and excluding a nested `<table>` handled above) never split it into further
  // blocks, matching the one-value-per-cell model `csv.parser.ts` already uses.
  if (parentContext.insideCellLikeContext) {
    return { context: parentContext, owned: { type: 'none' } };
  }

  if (tagName === 'tr' && parentContext.table !== undefined) {
    const row: Row = { cells: [] };
    return {
      context: { ...parentContext, row },
      owned: { type: 'row', row, table: parentContext.table },
    };
  }

  if ((tagName === 'td' || tagName === 'th') && parentContext.row !== undefined) {
    checkElementBudget(state);
    const accumulator: TextAccumulator = { parts: [], isPre: false };
    const cell: Cell = { text: '', colspan: parseColspan(getAttribute(element, 'colspan')) };
    parentContext.row.cells.push(cell);
    if (
      hasDisqualifyingRowspan(getAttribute(element, 'rowspan')) &&
      parentContext.table !== undefined
    ) {
      parentContext.table.hasDisqualifyingRowspan = true;
    }
    return {
      context: { ...parentContext, accumulator, insideCellLikeContext: true },
      owned: { type: 'cell', accumulator, cell },
    };
  }

  if (tagName === 'caption' && parentContext.table !== undefined) {
    checkElementBudget(state);
    const accumulator: TextAccumulator = { parts: [], isPre: false };
    parentContext.table.captionAccumulators.push(accumulator);
    return {
      context: { ...parentContext, accumulator, insideCellLikeContext: true },
      owned: { type: 'caption', accumulator, table: parentContext.table },
    };
  }

  const headingLevel = HEADING_LEVELS[tagName];
  if (headingLevel !== undefined) {
    state.headingTrail.length = Math.min(state.headingTrail.length, headingLevel - 1);
    checkElementBudget(state);
    const accumulator: TextAccumulator = { parts: [], isPre: false };
    const record: BlockRecord = { accumulator, text: '', headingPath: [] };
    state.blockRecords.push(record);
    return {
      context: { ...parentContext, accumulator },
      owned: { type: 'block', record, headingLevel },
    };
  }

  if (BLOCK_LEVEL_TAGS.has(tagName)) {
    checkElementBudget(state);
    const accumulator: TextAccumulator = { parts: [], isPre: tagName === 'pre' };
    const record: BlockRecord = { accumulator, text: '', headingPath: [...state.headingTrail] };
    state.blockRecords.push(record);
    return {
      context: { ...parentContext, accumulator },
      owned: { type: 'block', record },
    };
  }

  if (tagName === 'br' && parentContext.accumulator !== undefined) {
    appendVerbatim(parentContext.accumulator, '\n');
  }

  return { context: parentContext, owned: { type: 'none' } };
}

/** Finalizes whatever `owned` opened, run once its own subtree has been fully walked. */
function closeOwned(owned: OwnedKind, state: WalkState): void {
  if (owned.type === 'block') {
    owned.record.text = sanitizeEvidenceText(finalizeAccumulatorText(owned.record.accumulator));
    if (owned.headingLevel !== undefined) {
      if (owned.record.text !== '') {
        state.headingTrail.push(owned.record.text);
      }
      owned.record.headingPath = [...state.headingTrail];
    }
  } else if (owned.type === 'cell') {
    owned.cell.text = finalizeAccumulatorText(owned.accumulator);
  } else if (owned.type === 'row') {
    owned.table.rows.push(owned.row);
  } else if (owned.type === 'table') {
    finalizeTable(owned.table, owned.headingPath, state);
  }
  // 'caption' and 'none' need no close-time action: a caption's accumulator is read directly from
  // `table.captionAccumulators` by `finalizeTable`, once the enclosing table itself closes.
}

function walkDocument(document: DefaultTreeAdapterTypes.Document, state: WalkState): void {
  const rootContext: WalkContext = {
    suppressed: false,
    accumulator: undefined,
    insideCellLikeContext: false,
    table: undefined,
    row: undefined,
  };

  // Explicit stack, never recursion: `parse5` itself has already built the whole tree in memory,
  // but a recursive walk over it would still let an attacker-controlled nesting depth (the
  // adversarial spec's 50,000-deep `<div>`) overflow this parser's own call stack even though
  // `parse5.parse` survived it.
  const stack: StackItem[] = [];
  for (let index = document.childNodes.length - 1; index >= 0; index -= 1) {
    stack.push({ phase: 'open', node: document.childNodes[index], context: rootContext });
  }

  while (stack.length > 0) {
    const item = stack.pop()!;

    if (item.phase === 'close') {
      closeOwned(item.owned, state);
      continue;
    }

    const { node, context } = item;

    // `Element.nodeName` is typed as plain `string`, not a literal, so a `nodeName === '#text'`
    // check alone cannot narrow `Element` out of the union — checking for `tagName` first (present
    // on `Element`/`Template` only) is what lets the branches below narrow correctly.
    if (!('tagName' in node)) {
      if (node.nodeName === '#text') {
        if (node.value.trim() !== '') {
          state.sawNonWhitespaceText = true;
        }
        if (!context.suppressed && context.accumulator !== undefined) {
          appendText(context.accumulator, node.value);
        }
      }
      // '#comment' and '#documentType' carry no text and are dropped without further action.
      continue;
    }

    const element = node;
    const { context: childContext, owned } = openElement(element, context, state);
    stack.push({ phase: 'close', owned });

    // A raw-text/RCDATA element's own children are already covered by the endTag check in
    // `openElement` — `template`'s real content lives in `.content`, a separate `DocumentFragment`
    // never reachable from `childNodes` — so no special case is needed here either way.
    const children = element.childNodes;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ phase: 'open', node: children[index], context: childContext });
    }
  }
}

/**
 * Parses HTML with `parse5`, the WHATWG-compliant reference implementation — a hand-written
 * tokenizer over untrusted input would either re-implement raw-text/RCDATA states, entity
 * decoding, and misnested-tag recovery (the bug surface is the point) or silently mishandle them.
 *
 * `parse5` never refuses malformed input — recovery, not rejection, is its whole contract — so
 * every refusal this parser raises is its own bound, not `parse5`'s: {@link HTML_MAX_BYTES},
 * {@link HTML_MAX_NESTING_DEPTH}, {@link HTML_MAX_EMITTED_ELEMENTS}, an unterminated raw-text
 * element ({@link RAW_TEXT_SWALLOWING_TAGS}), and non-empty decoded input that yields zero
 * elements. Each fails CLOSED, refusing the document rather than emitting a truncated or empty
 * citation base. The first two are checked before `parseHtml` is called, because `parse5`'s own
 * cost on a deeply nested document is the thing they exist to bound.
 *
 * `<meta charset>` is never honoured — `decodeTextBuffer` resolves the encoding from the bytes
 * themselves, the same as every other parser in this package, before `parse5` ever sees the text.
 *
 * `script`, `style`, `template`, `noscript`, `iframe`, `object`, `embed`, `head`, comments, the
 * doctype, and every hidden element (a `hidden` attribute, a `display:none`/`visibility:hidden`
 * style, or `input[type=hidden]`) are dropped entirely — see {@link DROP_TAGS} for the raw-text
 * tags this parser drops beyond the plan's own six. A well-formed `<table>` (at least two rows, an
 * identical colspan-expanded width, no `rowspan` greater than one, no table nested inside it)
 * flattens to `xlsx-cell` elements reusing `csv.parser.ts`'s cell coordinates; any other table's
 * rows are emitted as `text-block`s instead, tab-joining that row's cells, with a
 * `reducedFidelityReasons` entry recording why.
 */
export class HtmlParser implements DocumentParser {
  readonly supports = [HTML_MIME_TYPE];

  parse(content: Buffer): Promise<ParsedDocument> {
    return Promise.resolve().then(() => {
      if (content.length > HTML_MAX_BYTES) {
        throw new MalformedHtmlException(
          `Document is ${content.length} bytes, exceeding the ${HTML_MAX_BYTES} byte limit this ` +
            'parser supports — split the page into smaller documents',
        );
      }

      const { text, encoding } = decodeTextBuffer(content);
      checkNestingDepth(text);
      const document = parseHtml(text, { sourceCodeLocationInfo: true });

      const state: WalkState = {
        openedRecordCount: 0,
        blockRecords: [],
        headingTrail: [],
        tableElementBatches: [],
        reducedFidelityReasons: [],
        nextTableOrdinal: 0,
        sawNonWhitespaceText: false,
      };
      walkDocument(document, state);

      let blockIndex = 0;
      const blockElements: ParsedElement[] = [];
      for (const record of state.blockRecords) {
        if (record.text === '') {
          continue;
        }
        const locator: TextBlockLocator = {
          kind: 'text-block',
          blockIndex,
          headingPath: record.headingPath,
          extractorVersion: EXTRACTOR_VERSION,
        };
        blockElements.push({ text: record.text, locator, headingPath: record.headingPath });
        blockIndex += 1;
      }

      const elements = [...blockElements, ...state.tableElementBatches.flat()];

      if (elements.length === 0 && state.sawNonWhitespaceText) {
        throw new MalformedHtmlException(
          'Document decodes to non-whitespace content but this parser emitted no elements from ' +
            'it — every element was dropped, hidden, or otherwise excluded',
        );
      }

      const reducedFidelityReasons = [
        ...state.reducedFidelityReasons,
        ...(encodingFidelityReasons(encoding) ?? []),
      ];

      return {
        elements,
        extractorVersion: EXTRACTOR_VERSION,
        reducedFidelityReasons:
          reducedFidelityReasons.length > 0 ? reducedFidelityReasons : undefined,
      };
    });
  }
}
