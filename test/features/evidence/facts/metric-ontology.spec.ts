import {
  findMetricByAlias,
  findMetricById,
  METRIC_IDS,
  METRIC_ONTOLOGY,
} from '../../../../src/features/evidence/facts/metric-ontology';

describe('METRIC_ONTOLOGY', () => {
  it('should declare a unique id for every metric', () => {
    const ids = METRIC_ONTOLOGY.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have exactly one METRIC_IDS entry per ontology entry', () => {
    expect(METRIC_ONTOLOGY.map((metric) => metric.id).sort()).toEqual([...METRIC_IDS].sort());
  });

  it('should declare a canonical-unit conversion (factor 1) for every metric', () => {
    for (const metric of METRIC_ONTOLOGY) {
      const canonical = metric.units.find((unit) => unit.id === metric.canonicalUnit);
      expect(canonical).toBeDefined();
      expect(canonical?.toCanonicalFactor).toBe(1);
    }
  });

  it('should declare between 6 and 8 metrics', () => {
    expect(METRIC_ONTOLOGY.length).toBeGreaterThanOrEqual(6);
    expect(METRIC_ONTOLOGY.length).toBeLessThanOrEqual(8);
  });
});

describe('findMetricByAlias', () => {
  it('should match a metric by its exact label', () => {
    expect(findMetricByAlias(METRIC_ONTOLOGY, 'Cap Rate')?.id).toBe('cap_rate');
  });

  it('should match a metric by an alias, case-insensitively and trimmed', () => {
    expect(findMetricByAlias(METRIC_ONTOLOGY, '  capitalization rate  ')?.id).toBe('cap_rate');
  });

  it('should match the exact xlsx header text for every column this ontology covers', () => {
    const headers = [
      'Building Area (SF)',
      'Sale Price (USD)',
      'Price per SF (USD)',
      'Cap Rate',
      'Net Operating Income (USD)',
    ];
    for (const header of headers) {
      expect(findMetricByAlias(METRIC_ONTOLOGY, header)).toBeDefined();
    }
  });

  it('should return undefined for a header that names no known metric', () => {
    expect(findMetricByAlias(METRIC_ONTOLOGY, 'Notes')).toBeUndefined();
    expect(findMetricByAlias(METRIC_ONTOLOGY, 'Property Name')).toBeUndefined();
  });
});

describe('findMetricById', () => {
  it('should return the metric for a known id', () => {
    expect(findMetricById(METRIC_ONTOLOGY, 'sale_price')?.label).toBe('Sale Price');
  });

  it('should return undefined for an unknown id', () => {
    expect(findMetricById(METRIC_ONTOLOGY, 'not_a_metric')).toBeUndefined();
  });
});
