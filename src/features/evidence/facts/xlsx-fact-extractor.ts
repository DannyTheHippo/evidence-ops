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
import { parseHeaderUnitMarker, resolveHeaderRow } from '../ingestion/sheet-header';
import { wordLookup } from '../qa/extract-numeric-tokens';

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

/** A cell under a column that named a valid metric, which produced no fact: its text is not a
 * number this file's grammar accepts (`parseDecimalAmount`), its unit is ambiguous, or its parsed
 * unit is not one the metric declares. Dropped rather than persisted as a guessed or coerced
 * amount, and reported rather than dropped silently. Mirrors `RejectedFactCandidate` in
 * `prose-fact-extractor.ts`: same "model proposes, extraction disposes" contract, applied here to
 * the deterministic display parsers instead of a model's structured output. */
export interface RejectedXlsxCandidate {
  readonly factKey: FactKey;
  /** Present only for a candidate that resolved to a complete `FactValue` and failed the
   *  unit-per-metric check afterwards. Absent for every refusal that never produced one — text the
   *  numeric grammar rejects, and an ambiguous percent-vs-ratio cell
   *  (`strictPercentUnitResolution`), which has an amount but no unit this parser can honestly
   *  assign. */
  readonly value?: FactValue;
  readonly locator: EvidenceLocator;
  readonly reason: string;
}

export interface XlsxFactExtractionResult {
  readonly accepted: FactCandidate[];
  readonly rejected: RejectedXlsxCandidate[];
  /** One entry per sheet whose header row could not be pinned down with confidence
   *  (`resolveHeaderRow`, sheet-header.ts), plus one entry per sheet with at least one entry in
   *  `rejected` above — `FactsService.buildXlsxCandidates` appends the whole array onto
   *  `DocumentVersion.reducedFidelityReasons` rather than leaving either signal unread. Always
   *  present, empty when nothing was ambiguous or rejected. */
  readonly reducedFidelityReasons: readonly string[];
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
//
// Returns `undefined` on a malformed address rather than throwing, unlike
// `resolve-xlsx-fact-chunk.ts`'s `parseRowFromCellAddress`: that helper's own doc comment states
// its throw is a deliberate invariant check on locators this codebase itself already persisted.
// This one runs over every element `extractXlsxFacts` is handed, including a workbook this
// parser only partially trusts (`xlsx.parser.ts` skips a cell whose merge range had a malformed
// address rather than aborting), so a defect here is one cell's, not a reason to drop every other
// cell's facts on the same sheet.
function parseCellAddress(cell: string): { column: string; row: number } | undefined {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) {
    return undefined;
  }
  const row = Number(match[2]);
  // `\d+` bounds the digits' shape but not their count, so a long enough run coerces to `Infinity`
  // and a run past `Number.MAX_SAFE_INTEGER` to a row number that no longer identifies one row.
  // Either way the address names no row this sheet can group cells by, so it takes the same
  // one-cell skip a malformed address does.
  return Number.isSafeInteger(row) ? { column: match[1], row } : undefined;
}

// Keyed by text taken from a spreadsheet cell (`[a-zA-Z]+`), so built through `wordLookup`'s null
// prototype: a plain object literal would resolve `'constructor'` to the `Object` function, which
// this declared `string` value type says cannot happen.
const MAGNITUDE_SUFFIXES: Readonly<Record<string, string>> = wordLookup({
  m: 'usd_millions',
  mm: 'usd_millions',
  million: 'usd_millions',
  k: 'usd_thousands',
  thousand: 'usd_thousands',
});

/** The numeric grammar every display parser in this file accepts: an optional leading minus, a run
 *  of ASCII decimal digits, and at most one fractional part. Deliberately narrower than `Number()`,
 *  which also reads `0x10` as 16, `1e400` and `Infinity` as `Infinity`, `1e-400` as 0, `+5` as 5,
 *  and `''` as 0 — none of which is the figure the cell displays. */
const DECIMAL_LITERAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * The one numeric coercion in this file. `cleaned` becomes an amount only when it is a decimal
 * literal {@link DECIMAL_LITERAL_PATTERN} accepts — an empty string is not — and the resulting
 * double faithfully represents it: finite, and no larger in magnitude than
 * {@link Number.MAX_SAFE_INTEGER}, past which two source figures a few units apart collapse onto
 * the same value. Mirrors `isRepresentableToken` in `qa/extract-numeric-tokens.ts`, which holds the
 * same line on the prose side.
 *
 * Fails CLOSED: text this refuses mints no fact, and every caller turns the refusal into a
 * `RejectedXlsxCandidate` so the cell is visibly dropped rather than silently coerced. A fact
 * amount that is not a finite number is worse than a missing fact — conflict detection compares it
 * with `>`, and every comparison against a non-finite value reads as agreement.
 */
function parseDecimalAmount(cleaned: string): number | undefined {
  if (!DECIMAL_LITERAL_PATTERN.test(cleaned)) {
    return undefined;
  }
  const amount = Number(cleaned);
  return Number.isFinite(amount) && Math.abs(amount) <= Number.MAX_SAFE_INTEGER
    ? amount
    : undefined;
}

/** The refusal every display parser returns for a cell under a metric column it cannot read as a
 *  number — `extractSheetFacts` records it as a rejection, which reaches an operator through
 *  `reducedFidelityReasons`. */
function refuse(text: string, expectation: string): { readonly reason: string } {
  return { reason: `cell displays '${text}' — ${expectation}` };
}

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
function parseCurrencyDisplay(text: string, metric: MetricDefinition): DisplayParseOutcome {
  const cleaned = text.replace(/[$,]/g, '').trim();
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(cleaned);
  if (!match) {
    return refuse(text, 'not a decimal currency amount, with or without a magnitude suffix');
  }
  const amount = parseDecimalAmount(match[1]);
  if (amount === undefined) {
    return refuse(text, 'amount is not a number a double faithfully represents');
  }
  const suffix = match[2]?.toLowerCase();
  if (!suffix) {
    const baseUnit = metric.units.find((unit) => unit.toCanonicalFactor === 1);
    return baseUnit
      ? { value: { amount, unit: baseUnit.id } }
      : refuse(text, `metric '${metric.id}' declares no base unit to read a bare amount as`);
  }
  const unitId = MAGNITUDE_SUFFIXES[suffix];
  // An unrecognized suffix ("41,000,000x") is not a currency amount this parser understands, and
  // a recognized suffix the metric itself never declares (a magnitude on `price_per_sf`) is
  // equally ungrounded — refusing either visibly is safer than guessing a magnitude that was never
  // stated, or that this metric has no unit for.
  const unitDeclared = unitId && metric.units.some((unit) => unit.id === unitId);
  return unitDeclared
    ? { value: { amount, unit: unitId } }
    : refuse(text, `magnitude suffix '${suffix}' names no unit metric '${metric.id}' declares`);
}

/** Either a resolved value, or a reason the cell under a metric column produced none —
 *  `extractSheetFacts` records the reason as a rejection rather than silently dropping it, the same
 *  "model proposes, extraction disposes" contract this file's own doc comments describe elsewhere,
 *  applied to what these parsers refuse rather than to what a model proposed. */
type DisplayParseOutcome = { readonly value: FactValue } | { readonly reason: string };

/** A `DisplayParseOutcome`, or `undefined` for a metric whose `valueType` this file has no parser
 *  for at all — the one case that is a gap in this module rather than a defect in the cell, so it
 *  is not reported against the document. */
type DisplayParseResult = DisplayParseOutcome | undefined;

/**
 * Resolves a percentage-valued cell in order: (1) an explicit '%' in the cell's own display text
 * — unambiguous regardless of anything else; (2) with `strictPercentUnitResolution` on, a unit
 * marker on the column header (`headerUnit`, from `parseHeaderUnitMarker` in sheet-header.ts); (3)
 * with the flag on and still nothing to go on, no fact at all rather than a guess. A metric that
 * declares only one of `percent`/`ratio` has nothing to disambiguate either way — its own sole
 * unit is the only honest reading regardless of marker.
 *
 * With `strictPercentUnitResolution` OFF (the default), no '%' in the display text means the cell
 * already holds the fraction a percentage would normalize to (e.g. `0.0525`), not a
 * percent-scale number — see
 * metric-ontology.ts's `ratio` vs `percent` units for how that distinction is reconciled
 * downstream. That default is what makes `5.25` in a bare "Cap Rate" column silently read as
 * `525%` when the two sheets it's compared against both used the same convention — the defect
 * this flag exists to let a caller opt out of.
 */
function parsePercentageDisplay(
  text: string,
  metric: MetricDefinition,
  headerUnit: 'percent' | 'ratio' | undefined,
  strictPercentUnitResolution: boolean,
): DisplayParseOutcome {
  const isPercent = text.includes('%');
  const cleaned = (isPercent ? text.replace('%', '') : text).trim();
  const amount = parseDecimalAmount(cleaned);
  if (amount === undefined) {
    return refuse(text, 'not a decimal percentage or ratio value');
  }
  if (isPercent) {
    return { value: { amount, unit: 'percent' } };
  }
  if (!strictPercentUnitResolution) {
    return { value: { amount, unit: 'ratio' } };
  }

  const declaresPercent = metric.units.some((unit) => unit.id === 'percent');
  const declaresRatio = metric.units.some((unit) => unit.id === 'ratio');
  if (declaresRatio && !declaresPercent) {
    return { value: { amount, unit: 'ratio' } };
  }
  if (declaresPercent && !declaresRatio) {
    return { value: { amount, unit: 'percent' } };
  }
  if (headerUnit) {
    return { value: { amount, unit: headerUnit } };
  }
  return {
    reason:
      `cell displays '${text}' with no '%', and column header names no percent/ratio unit ` +
      `either — ambiguous between percent and ratio for metric '${metric.id}'`,
  };
}

function parseAreaDisplay(text: string): DisplayParseOutcome {
  const cleaned = text.replace(/,/g, '').trim();
  const amount = parseDecimalAmount(cleaned);
  return amount === undefined
    ? refuse(text, 'not a decimal square-foot value')
    : { value: { amount, unit: 'sf' } };
}

function parseDisplayValue(
  text: string,
  metric: MetricDefinition,
  headerUnit: 'percent' | 'ratio' | undefined,
  strictPercentUnitResolution: boolean,
): DisplayParseResult {
  if (metric.valueType === 'percentage') {
    return parsePercentageDisplay(text, metric, headerUnit, strictPercentUnitResolution);
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
  /** Mirrors `ParsedElement.mergeCovered` — carried through so the fact-minting loop below can
   *  skip a merge-covered cell without also losing it from the header map and the entity/period/
   *  as-of lookups, which still need every cell in the row. */
  readonly mergeCovered?: true;
}

function extractSheetFacts(
  sheetName: string,
  elements: readonly ParsedElement[],
  ontology: readonly MetricDefinition[],
  strictPercentUnitResolution: boolean,
): XlsxFactExtractionResult {
  const cells: SheetCell[] = [];
  for (const element of elements) {
    const address = parseCellAddress((element.locator as XlsxCellLocator).cell);
    if (!address) {
      // A malformed cell address is a defect in this one cell, not the whole sheet — every other
      // cell on it is still real data worth keeping.
      continue;
    }
    cells.push({
      ...address,
      text: element.text,
      locator: element.locator,
      mergeCovered: element.mergeCovered,
    });
  }
  if (cells.length === 0) {
    return { accepted: [], rejected: [], reducedFidelityReasons: [] };
  }

  // Mirrors chunker.ts's identical assumption near its own header-row derivation — pointed at the
  // same sheet-header.ts module (via `detectHeaderRow`, which this resolution is consistent with)
  // so the two consumers cannot drift back apart.
  const { headerRow, reducedFidelityReason } = resolveHeaderRow(cells);
  const reducedFidelityReasons = reducedFidelityReason
    ? [`Sheet '${sheetName}': ${reducedFidelityReason}`]
    : [];
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
      if (cell.mergeCovered) {
        // A merge spanning several metric columns in a data row would otherwise mint one
        // identical-valued fact per column it covers — the merged cell was never actually about
        // every metric it happens to overlap, only the master cell's own column is.
        continue;
      }
      const header = headerByColumn.get(cell.column);
      if (!header) {
        continue;
      }
      const headerUnitMarker = strictPercentUnitResolution
        ? parseHeaderUnitMarker(header)
        : undefined;
      const metric =
        findMetricByAlias(ontology, header) ??
        (headerUnitMarker ? findMetricByAlias(ontology, headerUnitMarker.baseText) : undefined);
      if (!metric) {
        // Allowlist enforcement: a header that names no known metric (e.g. "Notes", or the entity
        // and period columns themselves) never produces a fact.
        continue;
      }
      const factKey: FactKey = { entity, metric: metric.id, period };
      const parsed = parseDisplayValue(
        cell.text,
        metric,
        headerUnitMarker?.unit,
        strictPercentUnitResolution,
      );
      if (!parsed) {
        // Only a metric whose `valueType` has no parser here reaches this — a cell this file can
        // read but refuses returns a reason instead, and is recorded below.
        continue;
      }
      if ('reason' in parsed) {
        rejected.push({ factKey, locator: cell.locator, reason: parsed.reason });
        continue;
      }
      const { value } = parsed;
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

  // Folded into `reducedFidelityReasons` rather than left for a caller to remember to consume
  // separately: a rejected candidate (text the numeric grammar refuses, a parsed unit its metric
  // doesn't declare, or — with `strictPercentUnitResolution` — a percent-vs-ratio cell this parser
  // refused to guess at) is exactly as much a fidelity loss as an ambiguous header, and both belong
  // on the same operator-visible signal. Deduplicated by reason text, so a sheet with the same
  // refusal repeated down a column produces one entry, not one per row.
  const rejectionReasons =
    rejected.length > 0
      ? [
          `Sheet '${sheetName}': ${rejected.length} cell(s) under a metric column ` +
            'produced no fact — ' +
            Array.from(new Set(rejected.map((candidate) => candidate.reason))).join('; '),
        ]
      : [];
  return {
    accepted,
    rejected,
    reducedFidelityReasons: [...reducedFidelityReasons, ...rejectionReasons],
  };
}

/** Derives `ExtractedFact` candidates from a parsed spreadsheet's cells with no model
 * involvement — the sheet already has perfect structure and provenance, so a model would only
 * trade certainty for cost. `elements` is expected to be homogeneous `xlsx-cell` output from
 * `XlsxParser`; a non-spreadsheet element is skipped rather than throwing, so a caller can pass a
 * mixed or empty array without special-casing it first.
 *
 * `strictPercentUnitResolution` is OFF by default and changes no caller's behaviour until a
 * caller opts in — see `parsePercentageDisplay`'s own doc comment for exactly what it changes.
 * Modelled on `verifyClaim`'s `subjectBinding` pin: a real defect (a bare-fraction percent column
 * silently read as its own value divided by 100) with a fix that also removes facts that exist
 * today, so it ships inert until a caller turns it on deliberately. */
export function extractXlsxFacts(
  elements: readonly ParsedElement[],
  ontology: readonly MetricDefinition[],
  strictPercentUnitResolution = false,
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
  const reducedFidelityReasons: string[] = [];
  for (const [sheetName, sheetElements] of bySheet) {
    const sheetResult = extractSheetFacts(
      sheetName,
      sheetElements,
      ontology,
      strictPercentUnitResolution,
    );
    accepted.push(...sheetResult.accepted);
    rejected.push(...sheetResult.rejected);
    reducedFidelityReasons.push(...sheetResult.reducedFidelityReasons);
  }
  return { accepted, rejected, reducedFidelityReasons };
}
