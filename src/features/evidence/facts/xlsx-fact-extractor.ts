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
import type { ParsedElement } from '../ingestion/parsers/parsed-element.type';

export interface FactCandidate {
  readonly factKey: FactKey;
  readonly value: FactValue;
  readonly rawText: string;
  readonly confidence: number;
  readonly extractionMethod: ExtractionMethod;
  readonly locator: EvidenceLocator;
}

// A spreadsheet has no dedicated "entity" or "period" column type — which header plays that role
// is a convention this fixture corpus follows and real data rooms generally follow too. Kept as a
// short alias list, matched the same case-insensitive way as a metric alias, rather than
// hardcoding the literal header text so a differently-cased or synonymous header still resolves.
const ENTITY_HEADER_ALIASES = ['property name', 'entity', 'asset name', 'property'];
const PERIOD_HEADER_ALIASES = ['sale date', 'date', 'period', 'transaction date'];

function normalizeHeader(text: string): string {
  return text.trim().toLowerCase();
}

function isEntityHeader(header: string | undefined): boolean {
  return header !== undefined && ENTITY_HEADER_ALIASES.includes(normalizeHeader(header));
}

function isPeriodHeader(header: string | undefined): boolean {
  return header !== undefined && PERIOD_HEADER_ALIASES.includes(normalizeHeader(header));
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
 */
function parseCurrencyDisplay(text: string): FactValue | undefined {
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
    return { amount, unit: 'usd' };
  }
  const unit = MAGNITUDE_SUFFIXES[suffix];
  // An unrecognized suffix ("41,000,000x") is not a currency amount this parser understands —
  // dropping it is safer than guessing a magnitude that was never stated.
  return unit ? { amount, unit } : undefined;
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
    return parseCurrencyDisplay(text);
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
): FactCandidate[] {
  const cells: SheetCell[] = elements.map((element) => ({
    ...parseCellAddress((element.locator as XlsxCellLocator).cell),
    text: element.text,
    locator: element.locator,
  }));
  if (cells.length === 0) {
    return [];
  }

  const headerRow = Math.min(...cells.map((cell) => cell.row));
  const headerByColumn = new Map<string, string>();
  for (const cell of cells.filter((cell) => cell.row === headerRow)) {
    headerByColumn.set(cell.column, cell.text);
  }

  const rowsByNumber = new Map<number, SheetCell[]>();
  for (const cell of cells.filter((cell) => cell.row !== headerRow)) {
    const row = rowsByNumber.get(cell.row) ?? [];
    row.push(cell);
    rowsByNumber.set(cell.row, row);
  }

  const candidates: FactCandidate[] = [];
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
      candidates.push({
        factKey: { entity, metric: metric.id, period },
        value,
        rawText: cell.text,
        // Deterministic, verbatim from the source cell — no model involved to be less than certain.
        confidence: 1,
        extractionMethod: 'regex',
        locator: cell.locator,
      });
    }
  }
  return candidates;
}

/** Derives `ExtractedFact` candidates from a parsed spreadsheet's cells with no model
 * involvement — the sheet already has perfect structure and provenance, so a model would only
 * trade certainty for cost. `elements` is expected to be homogeneous `xlsx-cell` output from
 * `XlsxParser`; a non-spreadsheet element is skipped rather than throwing, so a caller can pass a
 * mixed or empty array without special-casing it first. */
export function extractXlsxFacts(
  elements: readonly ParsedElement[],
  ontology: readonly MetricDefinition[],
): FactCandidate[] {
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

  const candidates: FactCandidate[] = [];
  for (const sheetElements of bySheet.values()) {
    candidates.push(...extractSheetFacts(sheetElements, ontology));
  }
  return candidates;
}
