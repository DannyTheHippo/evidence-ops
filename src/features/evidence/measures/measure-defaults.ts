import type { MeasureUnit } from '../../../database/schemas/evidence/measure/measure.schema';
import type { FactValueType, ToleranceKind } from '../facts/metric-ontology';

/** What a header-inferred proposal (`infer-header-measure.ts`) and a from-scratch manual measure
 * fall back to for `canonicalUnit`/`units` when nothing narrower is known — keyed by the same
 * `valueType` a proposal's cell text is classified into. */
export const DEFAULT_UNITS_BY_VALUE_TYPE: Readonly<
  Record<FactValueType, { canonicalUnit: string; units: readonly MeasureUnit[] }>
> = {
  percentage: {
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
  },
  currency: {
    canonicalUnit: 'usd',
    units: [
      { id: 'usd', toCanonicalFactor: 1 },
      { id: 'usd_thousands', toCanonicalFactor: 1_000 },
      { id: 'usd_millions', toCanonicalFactor: 1_000_000 },
    ],
  },
  area: {
    canonicalUnit: 'sf',
    units: [
      { id: 'sf', toCanonicalFactor: 1 },
      { id: 'thousand_sf', toCanonicalFactor: 1_000 },
    ],
  },
  duration: {
    canonicalUnit: 'years',
    units: [
      { id: 'years', toCanonicalFactor: 1 },
      { id: 'months', toCanonicalFactor: 1 / 12 },
    ],
  },
  count: {
    canonicalUnit: 'count',
    units: [{ id: 'count', toCanonicalFactor: 1 }],
  },
};

/** Same fallback role as `DEFAULT_UNITS_BY_VALUE_TYPE` above, for `toleranceKind`/`tolerance`. */
export const DEFAULT_TOLERANCE_BY_VALUE_TYPE: Readonly<
  Record<FactValueType, { toleranceKind: ToleranceKind; tolerance: number }>
> = {
  percentage: { toleranceKind: 'absolute', tolerance: 0.01 },
  currency: { toleranceKind: 'relative', tolerance: 0.01 },
  area: { toleranceKind: 'relative', tolerance: 0.01 },
  duration: { toleranceKind: 'absolute', tolerance: 0 },
  count: { toleranceKind: 'absolute', tolerance: 0 },
};
