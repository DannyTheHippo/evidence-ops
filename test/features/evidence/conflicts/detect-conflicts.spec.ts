import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import {
  detectConflicts,
  groupKey,
  type FactForConflictScan,
} from '../../../../src/features/evidence/conflicts/detect-conflicts';

function fact(overrides: Partial<FactForConflictScan> = {}): FactForConflictScan {
  return {
    id: 'fact-id',
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 5.25, unit: 'percent' },
    ...overrides,
  };
}

describe('detectConflicts', () => {
  it('should emit no conflict for a single fact (nothing to disagree with)', () => {
    expect(detectConflicts([fact({ id: 'a' })], METRIC_ONTOLOGY)).toEqual([]);
  });

  it('should emit a conflict when two facts sharing a key disagree past tolerance', () => {
    const facts = [
      fact({ id: 'xlsx-fact', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'pdf-fact', value: { amount: 6.1, unit: 'percent' } }),
    ];

    const conflicts = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factKey).toEqual(facts[0].factKey);
    expect(conflicts[0].factIds.sort()).toEqual(['pdf-fact', 'xlsx-fact']);
    expect(conflicts[0].magnitude).toBeCloseTo(0.0085, 10);
  });

  it('should not emit a conflict when two facts sharing a key agree within tolerance', () => {
    const facts = [
      fact({ id: 'a', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'b', value: { amount: 5.26, unit: 'percent' } }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual([]);
  });

  it('should group entities case-insensitively and trimmed, but keep metric and period exact', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      }),
      fact({
        id: 'b',
        factKey: { entity: '  northgate business park  ', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 6.1, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toHaveLength(1);
  });

  it('should not group facts with the same entity+metric but a different period', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-02' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: 'undated' },
        value: { amount: 6.1, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual([]);
  });

  it('should not group facts for different entities or different metrics', () => {
    const facts = [
      fact({
        id: 'a',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      }),
      fact({
        id: 'b',
        factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'cap_rate', period: '2025-03' },
        value: { amount: 9.9, unit: 'percent' },
      }),
      fact({
        id: 'c',
        factKey: { entity: 'Northgate Business Park', metric: 'sale_price', period: '2025-03' },
        value: { amount: 999, unit: 'usd' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual([]);
  });

  it('should include every fact in the group in factIds, not just the extremal pair', () => {
    const facts = [
      fact({ id: 'a', value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: 'b', value: { amount: 5.26, unit: 'percent' } }),
      fact({ id: 'c', value: { amount: 6.1, unit: 'percent' } }),
    ];

    const conflicts = detectConflicts(facts, METRIC_ONTOLOGY);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].factIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('should skip a group whose metric id is not in the ontology, without throwing', () => {
    const facts = [
      fact({ id: 'a', factKey: { entity: 'X', metric: 'not_a_real_metric', period: 'undated' } }),
      fact({
        id: 'b',
        factKey: { entity: 'X', metric: 'not_a_real_metric', period: 'undated' },
        value: { amount: 999, unit: 'percent' },
      }),
    ];

    expect(detectConflicts(facts, METRIC_ONTOLOGY)).toEqual([]);
  });

  it('should return no conflicts for an empty fact list', () => {
    expect(detectConflicts([], METRIC_ONTOLOGY)).toEqual([]);
  });
});

describe('groupKey', () => {
  it('should key entity case-insensitively and trimmed', () => {
    expect(groupKey({ entity: 'Acme', metric: 'sale_price', period: '2025' })).toBe(
      groupKey({ entity: '  ACME  ', metric: 'sale_price', period: '2025' }),
    );
  });
});
