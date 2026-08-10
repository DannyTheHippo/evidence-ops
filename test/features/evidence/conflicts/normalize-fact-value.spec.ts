import {
  findMetricById,
  METRIC_ONTOLOGY,
} from '../../../../src/features/evidence/facts/metric-ontology';
import {
  isConflictingPair,
  normalizeFactValue,
  UnknownMetricUnitError,
} from '../../../../src/features/evidence/conflicts/normalize-fact-value';

const capRate = findMetricById(METRIC_ONTOLOGY, 'cap_rate');
const salePrice = findMetricById(METRIC_ONTOLOGY, 'sale_price');

if (!capRate || !salePrice) {
  throw new Error('metric-ontology.ts is missing a metric this spec depends on');
}

describe('normalizeFactValue', () => {
  it('should treat "5.25%", "0.0525", and "5.25" (ratio) as the same cap rate', () => {
    const fromPercentSign = normalizeFactValue(capRate, { amount: 5.25, unit: 'percent' });
    const fromFraction = normalizeFactValue(capRate, { amount: 0.0525, unit: 'ratio' });
    const fromBareNumber = normalizeFactValue(capRate, { amount: 5.25, unit: 'percent' });

    expect(fromPercentSign).toBeCloseTo(0.0525, 10);
    expect(fromFraction).toBeCloseTo(0.0525, 10);
    expect(fromBareNumber).toBeCloseTo(0.0525, 10);
  });

  it('should treat "$12.0M" and "12000000" as the same sale price', () => {
    const fromMillions = normalizeFactValue(salePrice, { amount: 12, unit: 'usd_millions' });
    const fromPlainUsd = normalizeFactValue(salePrice, { amount: 12_000_000, unit: 'usd' });

    expect(fromMillions).toBe(fromPlainUsd);
    expect(fromMillions).toBe(12_000_000);
  });

  it('should throw UnknownMetricUnitError for a unit the metric does not declare', () => {
    expect(() => normalizeFactValue(capRate, { amount: 1, unit: 'usd' })).toThrow(
      UnknownMetricUnitError,
    );
  });
});

describe('isConflictingPair', () => {
  it('should flag an absolute-tolerance metric only past its threshold', () => {
    expect(isConflictingPair(capRate, 0.0525, 0.061)).toBe(true); // 85bp > 25bp tolerance
    expect(isConflictingPair(capRate, 0.0525, 0.053)).toBe(false); // 5bp < 25bp tolerance
  });

  it('should not flag a difference exactly equal to the absolute tolerance (strictly-greater-than boundary)', () => {
    expect(isConflictingPair(capRate, 0, capRate.tolerance)).toBe(false);
  });

  it('should flag a relative-tolerance metric only past its threshold', () => {
    expect(isConflictingPair(salePrice, 41_000_000, 41_000_000 * 1.02)).toBe(true); // 2% > 1%
    expect(isConflictingPair(salePrice, 41_000_000, 41_000_000 * 1.005)).toBe(false); // 0.5% < 1%
  });

  it('should treat two zero values as agreeing under a relative tolerance', () => {
    expect(isConflictingPair(salePrice, 0, 0)).toBe(false);
  });

  it('should treat a zero vs. nonzero pair as conflicting under a relative tolerance', () => {
    expect(isConflictingPair(salePrice, 0, 100)).toBe(true);
  });
});
