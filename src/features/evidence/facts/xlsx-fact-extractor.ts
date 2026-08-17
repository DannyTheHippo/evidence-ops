import type {
  EvidenceLocator,
  XlsxCellLocator,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type {
  ExtractionMethod,
  FactKey,
  FactValue,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { derivePeriodFromDateText } from './derive-period';
import { findMetricByAlias, type MetricDefinition } from './metric-ontology';
import { parseCalendarDate } from './parse-calendar-date';
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';
import { detectHeaderRow } from '../ingestion/sheet-header';

export interface FactCandidate {
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly rawText: string;
  readonly confidence: number;
  readonly extractionMethod: ExtractionMethod;
  readonly locator: EvidenceLocator;
  /** When the row has a dedicated as-of/recorded-date column (`AS_OF_HEADER_ALIASES`, distinct
   * from the period column `factKey.period` derives from) and that cell's text is a complete,
   * parseable calendar date — see `parseCalendarDate` (`parse-calendar-date.ts`). Absent whenever
   * the sheet has no such column, or the cell's text does not parse to a real date; never derived
   * from the period column, and never substituted with the current time or any other fallback. */
  readonly observedAt?: Date;
}

/** A cell that named a valid metric and parsed to a numeric value, but whose parsed unit is not
 * one the metric declares — dropped rather than persisted with a unit `normalizeFactValue` can
 * never convert. Mirrors `RejectedFactCandidate` in `prose-fact-extractor.ts`: same "model
 * proposes, extraction disposes" contract, applied here to the deterministic display parsers
 * instead of a model's structured output. */
export interface RejectedXlsxCandidate {
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly locator: EvidenceLocator;
  readonly reason: string;
}

export interface XlsxFactExtractionResult {
  readonly accepted: FactCandidate[];
  readonly rejected: RejectedXlsxCandidate[];
}

// A spreadsheet has no dedicated "entity" or "period" column type — which header plays that role
// is a convention this fixture corpus follows and real data rooms generally follow too. Kept as a
// short alias list, matched the same case-insensitive way as a metric alias, rather than
// hardcoding the literal header text so a differently-cased or synonymous header still resolves.
const ENTITY_HEADER_ALIASES = ['property name', 'entity', 'asset name', 'property'];
const PERIOD_HEADER_ALIASES = ['sale date', 'date', 'period', 'transaction date'];

// Deliberately disjoint from `PERIOD_HEADER_ALIASES`: a sale/transaction date describes what the
// row's value *is about* (`factKey.period`), not when someone recorded it (`observedAt`) — see
// `ExtractedFact.observedAt`'s own doc comment for that distinction. Only a column whose header
// names an as-of/recorded moment feeds `observedAt`; a sheet with no such column leaves it absent
// rather than borrowing the period column's value.
const AS_OF_HEADER_ALIASES = ['as of', 'as of date', 'recorded', 'recorded date', 'report date'];

function normalizeHeader(text: string): string {
  return text.trim().toLowerCase();
}

function isEntityHeader(header: string | undefined): boolean {
  return header !== undefined && ENTITY_HEADER_ALIASES.includes(normalizeHeader(header));
}

function isPeriodHeader(header: string | undefined): boolean {
  return header !== undefined && PERIOD_HEADER_ALIASES.includes(normalizeHeader(header));
}

function isAsOfHeader(header: string | undefined): boolean {
  return header !== undefined && AS_OF_HEADER_ALIASES.includes(normalizeHeader(header));
}

// Mirrors chunker.ts's own local A1-notation helpers — duplicated by design (see e.g.
// docx.parser.ts's MIME-constant comment for the same "one small helper, two call sites" call):
// this module and the chunker parse cell addresses for unrelated purposes (fact rows vs.
// window boundaries), so sharing an import would couple them for no benefit.
function parseCellAddress(cell: string): { column: string; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) {
    throw new Error(`Cell address '${cell}' is not in A1 notation`);
  }
  return { column: match[1], row: Number(match[2]) };
}

const MAGNITUDE_SUFFIXES: Readonly<Record<string, string>> = {
  m: 'usd_millions',
  mm: 'usd_millions',
  million: 'usd_millions',
  k: 'usd_thousands',
  thousand: 'usd_thousands',
};

/**
 * `$41,000,000` and `$12.0M` are both valid displayed forms of a currency cell; this recovers the
 * amount and which unit (plain dollars vs. a magnitude suffix) it was expressed in, so
 * `normalizeFactValue` (conflicts/normalize-fact-value.ts) is the only place that ever has to
 * reconcile the two.
 *
 * A currency column is not always dollars-per-whole-unit — `price_per_sf` and `base_rent_psf`
 * are dollar amounts too, but their ontology entry declares `usd_per_sf`/`usd_per_sf_per_year`,
 * never plain `usd`. A bare number with no magnitude suffix (`$276.10`) resolves to *this
 * metric's* own base unit (the one `MetricUnitDefinition` with `toCanonicalFactor === 1`), not a
 * hardcoded `usd` — otherwise a price-per-square-foot cell would silently mint a fact
 * `normalizeFactValue` can never convert for that metric, one that only ever measures whole
 * dollars. A magnitude suffix (`M`/`K`) still only resolves if the metric actually declares that
 * unit, so a suffix on a metric that has no notion of scale (`price_per_sf`) is rejected rather
 * than guessed.
 */
function parseCurrencyDisplay(text: string, metric: MetricDefinition): FactValue | undefined {
  const cleaned = text.replace(/[$,]/g, '').trim();
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(cleaned);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (Number.isNaN(amount)) {
    return undefined;
  }
  const suffix = match[2]?.toLowerCase();
  if (!suffix) {
    const baseUnit = metric.units.find((unit) => unit.toCanonicalFactor === 1);
    return baseUnit ? { amount, unit: baseUnit.id } : undefined;
  }
  const unitId = MAGNITUDE_SUFFIXES[suffix];
  // An unrecognized suffix ("41,000,000x") is not a currency amount this parser understands, and
  // a recognized suffix the metric itself never declares (a magnitude on `price_per_sf`) is
  // equally ungrounded — dropping either is safer than guessing a magnitude that was never
  // stated, or that this metric has no unit for.
  const unitDeclared = unitId && metric.units.some((unit) => unit.id === unitId);
  return unitDeclared ? { amount, unit: unitId } : undefined;
}

function parsePercentageDisplay(text: string): FactValue | undefined {
  const isPercent = text.includes('%');
  const cleaned = (isPercent ? text.replace('%', '') : text).trim();
  const amount = Number(cleaned);
  if (Number.isNaN(amount)) {
    return undefined;
  }
  // No '%' in the display text means the cell already holds the fraction a percentage would
  // normalize to (e.g. `0.0525`), not a percent-scale number — see metric-ontology.ts's `ratio`
  // vs `percent` units for how this distinction is reconciled downstream.
  return { amount, unit: isPercent ? 'percent' : 'ratio' };
}

function parseAreaDisplay(text: string): FactValue | undefined {
  const cleaned = text.replace(/,/g, '').trim();
  const amount = Number(cleaned);
  return Number.isNaN(amount) ? undefined : { amount, unit: 'sf' };
}

function parseDisplayValue(text: string, metric: MetricDefinition): FactValue | undefined {
  if (metric.valueType === 'percentage') {
    return parsePercentageDisplay(text);
  }
  if (metric.valueType === 'currency') {
    return parseCurrencyDisplay(text, metric);
  }
  if (metric.valueType === 'area') {
    return parseAreaDisplay(text);
  }
  // 'duration' metrics (e.g. lease_term_years) have no column in this ontology's spreadsheet
  // source — reachable only if a future column alias maps a header to one, at which point this
  // extractor would need an explicit parser for it rather than silently mis-parsing.
  return undefined;
}

interface SheetCell {
  readonly column: string;
  readonly row: number;
  readonly text: string;
  readonly locator: EvidenceLocator;
}

function extractSheetFacts(
  elements: readonly ParsedElement[],
  ontology: readonly MetricDefinition[],
): XlsxFactExtractionResult {
  const cells: SheetCell[] = elements.map((element) => ({
    ...parseCellAddress((element.locator as XlsxCellLocator).cell),
    text: element.text,
    locator: element.locator,
  }));
  if (cells.length === 0) {
    return { accepted: [], rejected: [] };
  }

  // Mirrors chunker.ts's identical assumption near its own header-row derivation — pointed at the
  // same detectHeaderRow helper (sheet-header.ts) so the two consumers cannot drift back apart.
  const headerRow = detectHeaderRow(cells);
  const headerByColumn = new Map<string, string>();
  for (const cell of cells.filter((cell) => cell.row === headerRow)) {
    headerByColumn.set(cell.column, cell.text);
  }

  const rowsByNumber = new Map<number, SheetCell[]>();
  // Strictly below the header, not merely "not the header row" — a row above the header (a
  // report-layout preamble/title) is not a data row and must not be walked for facts.
  for (const cell of cells.filter((cell) => cell.row > headerRow)) {
    const row = rowsByNumber.get(cell.row) ?? [];
    row.push(cell);
    rowsByNumber.set(cell.row, row);
  }

  const accepted: FactCandidate[] = [];
  const rejected: RejectedXlsxCandidate[] = [];
  for (const rowCells of rowsByNumber.values()) {
    const entityCell = rowCells.find((cell) => isEntityHeader(headerByColumn.get(cell.column)));
    const entity = entityCell?.text.trim();
    if (!entity) {
      // No entity column value on this row — there is nothing to key a fact to, so the row
      // contributes no facts rather than facts keyed to an empty entity string.
      continue;
    }
    const periodCell = rowCells.find((cell) => isPeriodHeader(headerByColumn.get(cell.column)));
    const period = derivePeriodFromDateText(periodCell?.text ?? '');
    // A distinct column from `periodCell` above (see `AS_OF_HEADER_ALIASES`'s own comment) —
    // `parseCalendarDate` only resolves a complete `YYYY-MM-DD` cell and leaves `observedAt`
    // absent for anything coarser or invalid, same as it would for the period column.
    const asOfCell = rowCells.find((cell) => isAsOfHeader(headerByColumn.get(cell.column)));
    const observedAt = asOfCell ? parseCalendarDate(asOfCell.text) : undefined;

    for (const cell of rowCells) {
      const header = headerByColumn.get(cell.column);
      if (!header) {
        continue;
      }
      const metric = findMetricByAlias(ontology, header);
      if (!metric) {
        // Allowlist enforcement: a header that names no known metric (e.g. "Notes", or the entity
        // and period columns themselves) never produces a fact.
        continue;
      }
      const value = parseDisplayValue(cell.text, metric);
      if (!value) {
        continue;
      }
      const factKey: FactKey = { entity, metric: metric.id, period };
      // Same unit-per-metric check `extractProseFacts` runs on a model's structured output
      // (prose-fact-extractor.ts) — applied here to the deterministic display parsers too, so a
      // parser that ever emits a unit its own metric doesn't declare is caught before persisting
      // rather than silently producing a fact `normalizeFactValue` can never convert.
      if (!metric.units.some((unit) => unit.id === value.unit)) {
        rejected.push({
          factKey,
          value,
          locator: cell.locator,
          reason: `unit '${value.unit}' is not valid for metric '${metric.id}'`,
        });
        continue;
      }
      accepted.push({
        factKey,
        value,
        rawText: cell.text,
        // Deterministic, verbatim from the source cell — no model involved to be less than certain.
        confidence: 1,
        extractionMethod: 'regex',
        locator: cell.locator,
        observedAt,
      });
    }
  }
  return { accepted, rejected };
}

/** Derives `ExtractedFact` candidates from a parsed spreadsheet's cells with no model
 * involvement — the sheet already has perfect structure and provenance, so a model would only
 * trade certainty for cost. `elements` is expected to be homogeneous `xlsx-cell` output from
 * `XlsxParser`; a non-spreadsheet element is skipped rather than throwing, so a caller can pass a
 * mixed or empty array without special-casing it first. */
export function extractXlsxFacts(
  elements: readonly ParsedElement[],
  ontology: readonly MetricDefinition[],
): XlsxFactExtractionResult {
  const bySheet = new Map<string, ParsedElement[]>();
  for (const element of elements) {
    if (element.locator.kind !== 'xlsx-cell') {
      continue;
    }
    const sheetName = element.locator.sheetName;
    const sheetElements = bySheet.get(sheetName) ?? [];
    sheetElements.push(element);
    bySheet.set(sheetName, sheetElements);
  }

  const accepted: FactCandidate[] = [];
  const rejected: RejectedXlsxCandidate[] = [];
  for (const sheetElements of bySheet.values()) {
    const sheetResult = extractSheetFacts(sheetElements, ontology);
    accepted.push(...sheetResult.accepted);
    rejected.push(...sheetResult.rejected);
  }
  return { accepted, rejected };
}
