import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  MAX_HEADER_TEXT_CHARS,
  MAX_MEASURE_SLUG_CHARS,
  type MeasureUnit,
} from '../../../database/schemas/evidence/measure/measure.schema';
import type { FactValueType, ToleranceKind } from '../facts/metric-ontology';
import { DEFAULT_TOLERANCE_BY_VALUE_TYPE, DEFAULT_UNITS_BY_VALUE_TYPE } from './measure-defaults';

/**
 * A header-inferred measure, not yet persisted — `xlsx-fact-extractor.ts` mints one of these per
 * unmatched numeric column when `XlsxExtractionContext.proposeFromHeaders` is on, and
 * `MeasuresService.proposeMany` is what turns it into a `Measure` row. Every text field here
 * traces back to the uploaded workbook and is bounded accordingly — see `deriveMeasureSlug` and
 * `buildHeaderProposal` below for exactly where those bounds are enforced.
 */
/**
 * The most distinct measures one document's headers may propose. A workbook is caller-supplied and
 * its column count is bounded only by the format (16,384 per sheet, times its sheets), so without
 * this every unmatched numeric column in a wide or hostile upload becomes a `Measure` row an admin
 * has to decide on — a queue no human can clear, filled by one file.
 *
 * Fails CLOSED: columns past the cap mint no proposal and therefore no facts, the same outcome an
 * unmatched column already has with `proposeFromHeaders` off. The bound is per document, so a
 * tenant's total across many documents is not bounded by it.
 */
export const MAX_HEADER_PROPOSALS_PER_DOCUMENT = 200;

export interface HeaderMeasureProposal {
  readonly slug: string;
  readonly label: string;
  readonly aliases: string[];
  readonly valueType: FactValueType;
  readonly canonicalUnit: string;
  readonly units: readonly MeasureUnit[];
  readonly toleranceKind: ToleranceKind;
  readonly tolerance: number;
  readonly headerText: string;
  readonly headerLocator: EvidenceLocator;
}

// `id` in `MEASURE_STATUSES`/`MeasureUnit.id`-shaped grammar (see `measure.schema.ts`'s own unit
// validator) and this file's own slug: lowercase, `_`-separated, `MAX_MEASURE_SLUG_CHARS` long at
// most, first character a letter. A slug this pattern refuses becomes a `Measure.slug` unique-index
// key and a stored document field, so a truncated-and-accepted slug is not an option here — the
// grammar is a hard gate, not a normalization.
const SLUG_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_MEASURE_SLUG_CHARS - 1}}$`);

/** A cell's displayed text this file reads as a number: an optional leading minus, an optional
 *  leading `$`, digits with optional thousands separators, an optional decimal part, an optional
 *  trailing `%`. Deliberately narrower than `Number()` for the same reason
 *  `xlsx-fact-extractor.ts`'s own `DECIMAL_LITERAL_PATTERN` is — a header proposal is minted from
 *  what a cell displays, not from whatever a looser grammar would coerce it to. */
const NUMERIC_CELL_PATTERN = /^-?\$?\d[\d,]*(?:\.\d+)?%?$/;

const PERCENT_HEADER_PATTERN = /%|\bpercent\b|\bpct\b/i;
const CURRENCY_HEADER_PATTERN = /\$|\busd\b/i;
const AREA_HEADER_PATTERN = /\bsf\b|\bsq ft\b|\bsqft\b|\bsquare feet\b/i;
const DURATION_HEADER_PATTERN = /\byears\b|\byrs\b|\bmonths\b/i;
const MONTHS_HEADER_PATTERN = /\bmonths\b/i;

/**
 * Derives a `Measure.slug` candidate from a spreadsheet column header: strips every parenthetical
 * group and the characters `$`/`%`, NFKC-folds and lowercases the rest, collapses every run of
 * non-alphanumeric characters to a single `_`, and trims leading/trailing `_`.
 *
 * Fails CLOSED on the untrusted header text: `undefined` for anything that does not end up
 * matching {@link SLUG_PATTERN} — a header that folds to nothing (only symbols) or to a slug
 * longer than `MAX_MEASURE_SLUG_CHARS` mints no slug at all, never a truncated one.
 */
export function deriveMeasureSlug(header: string): string | undefined {
  const withoutMarkers = header.replace(/\([^)]*\)/g, '').replace(/[$%]/g, '');
  const folded = withoutMarkers.normalize('NFKC').toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return SLUG_PATTERN.test(slug) ? slug : undefined;
}

/** Whether `text`, trimmed, is a number this file's grammar accepts — see
 *  {@link NUMERIC_CELL_PATTERN}. */
export function isNumericCellText(text: string): boolean {
  return NUMERIC_CELL_PATTERN.test(text.trim());
}

/**
 * Classifies a spreadsheet column's `FactValueType` from, in order, the column header's own
 * tokens (a `%`/`percent`/`pct` token → `percentage`; `usd`/`$` → `currency`;
 * `sf`/`sq ft`/`sqft`/`square feet` → `area`; `years`/`yrs`/`months` → `duration`) and, only when
 * the header names none of those, the column's numeric cell text (every numeric cell ending in
 * `%` → `percentage`; every numeric cell starting with `$` → `currency`; otherwise `count`).
 */
export function inferValueType(
  header: string,
  cellTexts: readonly string[],
): FactValueType | undefined {
  if (PERCENT_HEADER_PATTERN.test(header)) {
    return 'percentage';
  }
  if (CURRENCY_HEADER_PATTERN.test(header)) {
    return 'currency';
  }
  if (AREA_HEADER_PATTERN.test(header)) {
    return 'area';
  }
  if (DURATION_HEADER_PATTERN.test(header)) {
    return 'duration';
  }

  const numericCells = cellTexts
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && isNumericCellText(text));
  if (numericCells.length > 0 && numericCells.every((text) => text.endsWith('%'))) {
    return 'percentage';
  }
  if (numericCells.length > 0 && numericCells.every((text) => text.startsWith('$'))) {
    return 'currency';
  }
  return 'count';
}

/**
 * Proposes a header-inferred measure from one spreadsheet column, or refuses.
 *
 * Fails CLOSED: a mixed column is not a measure column. This returns `undefined` unless
 * {@link deriveMeasureSlug} succeeds on `header`, `cellTexts` has at least one non-empty entry,
 * AND every non-empty entry is numeric per {@link isNumericCellText} — a column that is mostly
 * numbers with one stray label mints nothing, rather than a proposal built from a partial read of
 * the column.
 *
 * `label`, every entry of `aliases`, and `headerText` are each `header.trim()` capped at
 * `MAX_HEADER_TEXT_CHARS` — the same bound `measure.schema.ts` enforces on the stored document
 * field, applied here too so a proposal never carries text the schema would truncate silently on
 * save. `canonicalUnit`/`units`/`toleranceKind`/`tolerance` come from
 * `DEFAULT_UNITS_BY_VALUE_TYPE`/`DEFAULT_TOLERANCE_BY_VALUE_TYPE`, except a `duration` column whose
 * header names `months` specifically (rather than `years`/`yrs`) gets `months` as its own
 * factor-1 canonical unit instead of the default `years`.
 */
export function buildHeaderProposal(
  header: string,
  headerLocator: EvidenceLocator,
  cellTexts: readonly string[],
): HeaderMeasureProposal | undefined {
  const slug = deriveMeasureSlug(header);
  if (!slug) {
    return undefined;
  }
  const nonEmptyCells = cellTexts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (nonEmptyCells.length === 0 || !nonEmptyCells.every((text) => isNumericCellText(text))) {
    return undefined;
  }
  const valueType = inferValueType(header, cellTexts);
  if (!valueType) {
    return undefined;
  }

  const unitDefaults =
    valueType === 'duration' && MONTHS_HEADER_PATTERN.test(header)
      ? {
          canonicalUnit: 'months',
          units: [
            { id: 'months', toCanonicalFactor: 1 },
            { id: 'years', toCanonicalFactor: 12 },
          ],
        }
      : DEFAULT_UNITS_BY_VALUE_TYPE[valueType];
  const toleranceDefaults = DEFAULT_TOLERANCE_BY_VALUE_TYPE[valueType];
  const boundedText = header.trim().slice(0, MAX_HEADER_TEXT_CHARS);

  return {
    slug,
    label: boundedText,
    aliases: [boundedText],
    valueType,
    ...unitDefaults,
    ...toleranceDefaults,
    headerText: boundedText,
    headerLocator,
  };
}
