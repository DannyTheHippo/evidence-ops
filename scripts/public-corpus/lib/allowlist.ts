/**
 * Candidate REIT registrants for the public-corpus benchmark. Each `cik` is verified against
 * `data.sec.gov/submissions/CIK<cik>.json`'s own `name` at fetch time (`fetch-edgar.ts`); a
 * registrant whose returned name does not match is dropped before the allowlist is committed
 * (plan Assumptions 2), never silently kept.
 */
function zeroPadCik(cik: number): string {
  return String(cik).padStart(10, '0');
}

const REIT_REGISTRANT_SOURCE: readonly { cik: number; name: string }[] = [
  { cik: 1045609, name: 'Prologis' },
  { cik: 1063761, name: 'Simon Property Group' },
  { cik: 726728, name: 'Realty Income' },
  { cik: 1393311, name: 'Public Storage' },
  { cik: 1101239, name: 'Equinix' },
  { cik: 915912, name: 'AvalonBay' },
  { cik: 1037540, name: 'BXP' },
  { cik: 879101, name: 'Kimco' },
  { cik: 766704, name: 'Welltower' },
  { cik: 1297996, name: 'Digital Realty' },
  { cik: 740260, name: 'Ventas' },
  { cik: 1070750, name: 'Host Hotels' },
  { cik: 899689, name: 'Vornado' },
  { cik: 34903, name: 'Federal Realty' },
  { cik: 910606, name: 'Regency Centers' },
  { cik: 1289490, name: 'Extra Space Storage' },
  { cik: 920522, name: 'Essex' },
  { cik: 912595, name: 'Mid-America Apartment' },
  { cik: 1035443, name: 'Alexandria' },
];

export const REIT_REGISTRANTS: readonly { readonly cik: string; readonly name: string }[] =
  REIT_REGISTRANT_SOURCE.map(({ cik, name }) => ({ cik: zeroPadCik(cik), name }));

/** Exact match against a filing's `form`; amendments (`10-K/A`) are excluded by construction. */
export const FORMS = ['10-K', '10-Q'] as const;

// The window is closed on purpose: its XBRL frames have settled, so a later re-run yields the
// same manifest, and FY2025 10-Ks filed in 2026 are excluded (plan Assumptions 3).
export const FILED_FROM = '2024-01-01';
export const FILED_TO = '2025-12-31';

/** Filename substrings (after stripping a dash right after `ex`) that mark an exhibit worth fetching. */
export const EXHIBIT_INCLUDE_HINTS = [
  'ex19',
  'ex21',
  'ex23',
  'ex31',
  'ex32',
  'ex97',
  'ex99',
] as const;

// Derivative renderings and index/summary pages the filer did not author as prose (`R\d+.htm`,
// `FilingSummary`, `Financial_Report`), plus material-contract and instrument exhibits (`ex10`,
// `ex4`) that are legal boilerplate, not measurable filing content.
export const EXCLUDED_FILENAME_PATTERNS: readonly RegExp[] = [
  /^R\d+\.htm$/i,
  /-index\.html?$/i,
  /^FilingSummary/i,
  /^Financial_Report/i,
  /^ex-?10/i,
  /^ex-?4/i,
];

export const FILE_EXTENSIONS = ['htm', 'html', 'pdf'] as const;

/**
 * Minimum spacing between EDGAR request starts. `EdgarClient` clamps to this floor (or SEC's own
 * 100ms fair-access floor, whichever is stricter) regardless of what a caller passes, so the 10
 * requests/second cap cannot be exceeded by accident.
 */
export const MIN_REQUEST_INTERVAL_MS = 150;

export interface Selection {
  readonly registrantCount: number;
  readonly filedFrom: string;
  readonly filedTo: string;
  readonly maxFilingsPerRegistrantPerForm: number;
}

// The coarse pre-sizing cut: every registrant, the whole window, up to 4 filings per
// (registrant, form). `corpus:size` (5.8) recommends a tighter value from the chunk/spend/hour
// bounds; 5.12 writes that value back here before the full fetch.
export const SELECTION: Selection = {
  registrantCount: REIT_REGISTRANTS.length,
  filedFrom: FILED_FROM,
  filedTo: FILED_TO,
  maxFilingsPerRegistrantPerForm: 4,
};
