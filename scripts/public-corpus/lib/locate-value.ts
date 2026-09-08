import type { ParsedElement } from '../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import type { Locator } from '../../../eval/dataset/schema';

/** Looser than `render-values.ts`'s own `RenderedForm` (`scale: 1 | 1e3 | 1e6`) on purpose: this
 *  function only ever substring-matches `text` and passes `scale` through unexamined, so it accepts
 *  any renderer's output, not only `render-values.ts`'s three currency scales. */
export interface RenderedForm {
  readonly text: string;
  readonly scale: number;
}

export type LocateValueResult =
  | {
      readonly locator: Locator;
      readonly matchedText: string;
      readonly scale: number;
      readonly labelMatched: string;
    }
  | { readonly reason: 'not-found' | 'ambiguous' };

interface CellAddress {
  readonly column: number;
  readonly row: number;
}

// Deliberately duplicated rather than importing eval/resolve-locator.ts's private
// `parseAddress`/`columnToIndex`: that module is out of this file's grant (`scripts/public-corpus/`),
// and `eval/metrics/locator-overlap.ts` already sets the precedent of a small self-contained
// duplicate over widening an out-of-scope file's contract.
function parseCellAddress(address: string): CellAddress {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) {
    throw new Error(`not an A1-style cell address: ${address}`);
  }
  const column = match[1]
    .split('')
    .reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1), 0);
  return { column, row: Number(match[2]) };
}

/**
 * A candidate's row label: column A of the same `sheetName`/row for an `xlsx-cell` element (the
 * label sits in a different cell — a candidate that is itself column A has no label of its own and
 * is never a location), the element's own text for a `text-block` (a not-flattened table row
 * tab-joins its label and value into one element, per `html.parser.ts`'s `finalizeTable`) or a
 * `pdf-page` (a page's flowing prose carries label and value together). Any other locator kind
 * carries no label this function knows how to read and is never a candidate.
 */
function labelFor(element: ParsedElement, elements: readonly ParsedElement[]): string | undefined {
  if (element.locator.kind === 'xlsx-cell') {
    const sheetName = element.locator.sheetName;
    const address = parseCellAddress(element.locator.cell);
    if (address.column === 1) {
      return undefined;
    }
    const columnA = elements.find(
      (candidate) =>
        candidate.locator.kind === 'xlsx-cell' &&
        candidate.locator.sheetName === sheetName &&
        parseCellAddress(candidate.locator.cell).column === 1 &&
        parseCellAddress(candidate.locator.cell).row === address.row,
    );
    return columnA?.text;
  }
  if (element.locator.kind === 'text-block' || element.locator.kind === 'pdf-page') {
    return element.text;
  }
  return undefined;
}

/**
 * Locates a rendered XBRL value among a document's parsed elements. A candidate is an element whose
 * text contains one of `forms`; it counts only when its row label contains a `labelTokens` word —
 * "Total assets" and "Total liabilities and equity" share a bare value on every balance sheet, so an
 * unlabelled hit alone is a guess, not a location. Exactly one labelled candidate resolves to a
 * locator; zero is `not-found`; more than one is `ambiguous` — never picked between.
 */
export function locateValue(
  elements: readonly ParsedElement[],
  forms: readonly RenderedForm[],
  labelTokens: readonly string[],
  file: string,
): LocateValueResult {
  const candidates: { element: ParsedElement; form: RenderedForm; label: string }[] = [];

  for (const element of elements) {
    const form = forms.find((candidateForm) => element.text.includes(candidateForm.text));
    if (!form) {
      continue;
    }
    const label = labelFor(element, elements);
    if (label === undefined) {
      continue;
    }
    const normalizedLabel = label.toLowerCase();
    const hasLabelWord = labelTokens.some((token) => normalizedLabel.includes(token.toLowerCase()));
    if (!hasLabelWord) {
      continue;
    }
    candidates.push({ element, form, label });
  }

  if (candidates.length === 0) {
    return { reason: 'not-found' };
  }
  if (candidates.length > 1) {
    return { reason: 'ambiguous' };
  }

  const [{ element, form, label }] = candidates;
  const locator: Locator | undefined =
    element.locator.kind === 'xlsx-cell'
      ? { kind: 'xlsx-cell', file, sheet: element.locator.sheetName, cell: element.locator.cell }
      : element.locator.kind === 'text-block'
        ? { kind: 'text-block', file, blockIndex: element.locator.blockIndex }
        : element.locator.kind === 'pdf-page'
          ? { kind: 'pdf-page', file, page: element.locator.page }
          : undefined;

  // Unreachable: `labelFor` returns `undefined` for any locator kind other than the three handled
  // above, so no candidate ever reaches this point with an unsupported kind.
  if (!locator) {
    return { reason: 'not-found' };
  }

  return { locator, matchedText: form.text, scale: form.scale, labelMatched: label };
}
