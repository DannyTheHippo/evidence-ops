import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { agreeFacts } from '../../../../src/features/evidence/facts/agree-facts';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import type { ExtractedFactInput } from '../../../../src/features/evidence/facts/prose-fact-extractor';

const LOCATOR: EvidenceLocator = { kind: 'pdf-page', page: 2, extractorVersion: 'v1' };

function capRateFact(overrides: Partial<ExtractedFactInput> = {}): ExtractedFactInput {
  return {
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    value: { amount: 6.1, unit: 'percent' },
    rawText: 'at a cap rate of approximately 6.10%',
    confidence: 0.9,
    extractionMethod: 'llm',
    locator: LOCATOR,
    ...overrides,
  };
}

describe('agreeFacts', () => {
  it('should keep a fact all 3 passes agree on unanimously', () => {
    const { facts, report } = agreeFacts(
      [[capRateFact()], [capRateFact()], [capRateFact()]],
      METRIC_ONTOLOGY,
    );

    expect(facts).toHaveLength(1);
    expect(facts[0].factKey).toEqual(capRateFact().factKey);
    expect(facts[0].confidence).toBeCloseTo(0.9, 10);
    expect(report).toEqual({
      totalGroups: 1,
      survivingFacts: 1,
      droppedGroups: [],
      unnormalizable: [],
    });
  });

  it('should keep a fact 2 of 3 passes agree on, dropping the odd pass out of the surviving cluster', () => {
    const { facts, report } = agreeFacts(
      [
        [capRateFact({ value: { amount: 6.1, unit: 'percent' }, confidence: 0.9 })],
        [capRateFact({ value: { amount: 6.12, unit: 'percent' }, confidence: 0.8 })],
        [capRateFact({ value: { amount: 9.5, unit: 'percent' }, confidence: 0.7 })],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toHaveLength(1);
    // Confidence is the mean of only the two agreeing passes (0.9, 0.8), not all three.
    expect(facts[0].confidence).toBeCloseTo(0.85, 10);
    expect(report.survivingFacts).toBe(1);
    expect(report.droppedGroups).toEqual([]);
  });

  it('should drop a group where only 1 of 3 passes proposed a given value with no agreement', () => {
    const { facts, report } = agreeFacts(
      [
        [capRateFact({ value: { amount: 6.1, unit: 'percent' } })],
        [capRateFact({ value: { amount: 7.0, unit: 'percent' } })],
        [capRateFact({ value: { amount: 8.0, unit: 'percent' } })],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toEqual([]);
    expect(report.droppedGroups).toEqual([
      {
        factKey: capRateFact().factKey,
        agreeingPasses: 1,
        totalPasses: 3,
      },
    ]);
  });

  // cap_rate's tolerance is 0.0025 in its canonical `ratio` unit. Values are given directly in
  // `ratio` (factor 1, no `* 0.01` conversion) so the boundary math is exact in binary
  // floating point rather than landing on a `percent`-conversion rounding artifact — `0 - x` and
  // `Math.abs` introduce no rounding of their own, so `0` vs `metric.tolerance` is bit-exact.
  it('should treat values exactly at the tolerance boundary as agreeing', () => {
    const { facts } = agreeFacts(
      [
        [capRateFact({ value: { amount: 0, unit: 'ratio' } })],
        [capRateFact({ value: { amount: 0.0025, unit: 'ratio' } })],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toHaveLength(1);
  });

  it('should treat values just past the tolerance boundary as disagreeing', () => {
    const { facts, report } = agreeFacts(
      [
        [capRateFact({ value: { amount: 0, unit: 'ratio' } })],
        [capRateFact({ value: { amount: 0.0026, unit: 'ratio' } })],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toEqual([]);
    expect(report.droppedGroups).toEqual([
      { factKey: capRateFact().factKey, agreeingPasses: 1, totalPasses: 2 },
    ]);
  });

  it('should return no facts and an empty report when every pass failed (an empty passResults array)', () => {
    const { facts, report } = agreeFacts([], METRIC_ONTOLOGY);

    expect(facts).toEqual([]);
    expect(report).toEqual({
      totalGroups: 0,
      survivingFacts: 0,
      droppedGroups: [],
      unnormalizable: [],
    });
  });

  it('should still reach agreement when a third pass threw and only 2 successful passes remain', () => {
    // Mirrors what `extractProseFacts` hands this module after filtering out a thrown pass:
    // `passResults` only ever contains successful passes, so 2 entries here is the whole story.
    const { facts, report } = agreeFacts(
      [
        [capRateFact({ value: { amount: 6.1, unit: 'percent' } })],
        [capRateFact({ value: { amount: 6.12, unit: 'percent' } })],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toHaveLength(1);
    expect(report.survivingFacts).toBe(1);
  });

  it('should fail open on an unnormalizable unit — drop only that candidate, visibly, not the group', () => {
    const { facts, report } = agreeFacts(
      [
        [capRateFact({ value: { amount: 6.1, unit: 'percent' } })],
        [capRateFact({ value: { amount: 6.12, unit: 'percent' } })],
        [capRateFact({ value: { amount: 6.1, unit: 'usd' } })], // not a cap_rate unit
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toHaveLength(1);
    expect(report.unnormalizable).toEqual([
      {
        fact: capRateFact({ value: { amount: 6.1, unit: 'usd' } }),
        reason: "unit 'usd' is not valid for metric 'cap_rate'",
      },
    ]);
  });

  it('should not group facts for different entities, metrics, or periods', () => {
    const { facts } = agreeFacts(
      [
        [
          capRateFact({
            factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          }),
        ],
        [
          capRateFact({
            factKey: {
              entity: 'Cedar Bluff Logistics Center',
              metric: 'cap_rate',
              period: '2025-03',
            },
          }),
        ],
      ],
      METRIC_ONTOLOGY,
    );

    expect(facts).toEqual([]);
  });
});
