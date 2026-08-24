import type {
  MetricDefinition,
  MetricPackData,
} from '../../../../src/database/schemas/evidence/metric-pack/metric-pack.schema';
import { diffDetectionRelevantMetrics } from '../../../../src/features/evidence/facts/diff-metric-packs';

function capRate(overrides: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: 'cap_rate',
    label: 'Cap Rate',
    aliases: ['Cap Rate'],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    toleranceKind: 'absolute',
    tolerance: 0.0025,
    ...overrides,
  };
}

function salePrice(overrides: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: 'sale_price',
    label: 'Sale Price',
    aliases: ['Sale Price'],
    valueType: 'currency',
    canonicalUnit: 'usd',
    units: [{ id: 'usd', toCanonicalFactor: 1 }],
    toleranceKind: 'relative',
    tolerance: 0.01,
    ...overrides,
  };
}

function pack(metrics: MetricDefinition[]): MetricPackData {
  return { packId: 'cre-fork', version: 1, label: 'Fork', metrics };
}

describe('diffDetectionRelevantMetrics', () => {
  it('should return no metric ids when nothing about detection changed', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([capRate(), salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual([]);
  });

  it('should return no metric ids for a labels/aliases-only edit', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([
      capRate({ label: 'Capitalization Rate', aliases: ['Cap Rate', 'Cap. Rate'] }),
      salePrice(),
    ]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual([]);
  });

  it('should name a metric whose tolerance changed', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([capRate({ tolerance: 0.005 }), salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });

  it('should name a metric whose toleranceKind changed', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([capRate({ toleranceKind: 'relative' }), salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });

  it('should name a metric whose canonicalUnit changed', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([capRate({ canonicalUnit: 'percent' }), salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });

  it('should name a metric whose units gained a new conversion', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([
      capRate({ units: [...capRate().units, { id: 'bps', toCanonicalFactor: 0.0001 }] }),
      salePrice(),
    ]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });

  it('should not name a metric whose units array was only reordered', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([capRate({ units: [...capRate().units].reverse() }), salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual([]);
  });

  it('should name a metric newly added in next', () => {
    const previous = pack([salePrice()]);
    const next = pack([salePrice(), capRate()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });

  it('should name a metric removed from next', () => {
    const previous = pack([capRate(), salePrice()]);
    const next = pack([salePrice()]);

    expect(diffDetectionRelevantMetrics(previous, next)).toEqual(['cap_rate']);
  });
});
