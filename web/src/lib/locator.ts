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
  }
}
