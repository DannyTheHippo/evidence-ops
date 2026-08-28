import type { Locator } from '../api/client';

// Matches the citation quoted at the top of the API's `Citation` shape: a human-readable
// pointer into a specific document version, e.g. "p.2" or "Comps!F2".
export function formatLocator(locator: Locator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `p.${locator.page}`;
    case 'xlsx-cell':
      return `${locator.sheetName}!${locator.cell}`;
    case 'xlsx-region':
      return `${locator.sheetName}!${locator.range}`;
    case 'docx-paragraph':
      return locator.headingPath.length > 0
        ? locator.headingPath.join(' > ')
        : `¶${locator.paragraphIndex}`;
    case 'text-block':
      return locator.headingPath.length > 0
        ? locator.headingPath.join(' > ')
        : `¶${locator.blockIndex}`;
    case 'pptx-slide':
      return `slide ${locator.slide}`;
  }
}

/** The key chunks with the same locator "neighbourhood" share, for grouping a flat chunk list
 * into an outline: pdf-page groups by page, xlsx by sheet, docx/text-block by top heading (or an
 * untitled bucket when the source carried no heading), pptx by slide. */
export function locatorGroupKey(locator: Locator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `page:${locator.page}`;
    case 'xlsx-cell':
    case 'xlsx-region':
      return `sheet:${locator.sheetName}`;
    case 'docx-paragraph':
    case 'text-block':
      return locator.headingPath.length > 0 ? `heading:${locator.headingPath[0]}` : 'heading:';
    case 'pptx-slide':
      return `slide:${locator.slide}`;
  }
}

/** The heading shown above a `locatorGroupKey` group. */
export function locatorGroupLabel(locator: Locator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `Page ${locator.page}`;
    case 'xlsx-cell':
    case 'xlsx-region':
      return locator.sheetName;
    case 'docx-paragraph':
    case 'text-block':
      return locator.headingPath.length > 0 ? locator.headingPath[0] : 'Untitled section';
    case 'pptx-slide':
      return `Slide ${locator.slide}`;
  }
}

/** The PDF page a locator points at, for jumping the workbench's PDF pane there — `null` for
 * every other locator kind, since only a `pdf-page` locator names one. */
export function pdfPageOf(locator: Locator): number | null {
  switch (locator.kind) {
    case 'pdf-page':
      return locator.page;
    case 'xlsx-cell':
    case 'xlsx-region':
    case 'docx-paragraph':
    case 'text-block':
    case 'pptx-slide':
      return null;
  }
}
