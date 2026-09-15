import type { LedgerValue } from '../api/client';

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

/**
 * Groups thousands for a numeric fact value, preserving every digit the value carries — a spread
 * of 0.0085 renders as 0.0085, not 0.009. Locale is pinned to `en-US` rather than the runtime's,
 * so the grouping separator stays a comma regardless of the machine the app runs on. For
 * `|value| < 1000` the output equals `String(value)` byte for byte, because grouping has nothing
 * to add below the thousands boundary.
 */
export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/**
 * `formatNumber` plus the unit token unchanged: '1,250,000 usd'. No unit renders the number
 * alone.
 */
export function formatValue(value: number, unit?: string): string {
  const formatted = formatNumber(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

/** A ledger fact or resolved cell value, grouped and labelled with its own unit. */
export function formatMeasureValue(value: LedgerValue): string {
  return formatValue(value.amount, value.unit);
}

/** The canonical-unit reading, or `undefined` when the value carries none — the caller then
 * renders no canonical reading at all rather than the string `undefined`. `canonicalUnit` is the
 * measure's own canonical unit, not `value.unit` — a fact's recorded unit and its canonical
 * reading can differ, which is the whole point of converting. */
export function formatCanonicalValue(
  value: LedgerValue,
  canonicalUnit?: string,
): string | undefined {
  return value.canonicalAmount === undefined
    ? undefined
    : formatValue(value.canonicalAmount, canonicalUnit);
}
