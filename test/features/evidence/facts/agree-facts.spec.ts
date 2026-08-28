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

// `sale_price`'s `usd_millions` unit has a `toCanonicalFactor` of `1_000_000` — the case that
// proves the guard has to inspect the converted canonical value, not the raw `amount`: an amount
// well inside `Number.MAX_SAFE_INTEGER` on its own can still convert to a canonical value beyond
// it.
function saleFact(overrides: Partial<ExtractedFactInput> = {}): ExtractedFactInput {
  return {
    factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'sale_price', period: '2025-03' },
    value: { amount: 41, unit: 'usd_millions' },
    rawText: 'sold for $41.0 million',
    confidence: 0.9,
    extractionMethod: 'llm',
    locator: LOCATOR,
    ...overrides,
  };
}

// Every canonical value a vote's comparator (`isConflictingPair`) cannot meaningfully order:
// non-finite, and finite-but-beyond `Number.MAX_SAFE_INTEGER`, where a double's 53-bit mantissa
// can no longer distinguish the value from its neighbors. `cap_rate`'s `ratio` unit has a
// `toCanonicalFactor` of `1`, so these double as both the raw `amount` and the canonical value.
const POISON_CANONICALS: readonly [label: string, canonical: number][] = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
  ['beyond -MAX_SAFE_INTEGER', -(Number.MAX_SAFE_INTEGER + 2)],
  ['1e16', 1e16],
  ['MAX_VALUE', Number.MAX_VALUE],
];

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

  describe('the never-agreement invariant for a poisoned canonical value', () => {
    // Class sweep for the false-agreement defect this module shares with `detectConflicts`:
    // `isConflictingPair`'s `>` comparisons are all `false` against `NaN`, and — for a
    // relative-tolerance metric, where `diff / base` collapses to `NaN` once either side is
    // infinite — against `Infinity` too. Either way a poisoned vote reads as "agrees with
    // everything", can survive `MIN_AGREEING_PASSES`, and can win the earliest-`passIndex`
    // tiebreak that selects the persisted representative. Beyond `Number.MAX_SAFE_INTEGER` a
    // double can no longer distinguish the value from its neighbors either, so it is swept
    // alongside the non-finite cases rather than treated as a separate class.
    it.each(POISON_CANONICALS)(
      'should exclude a poisoned canonical (%s) from agreement, whether it arrives on the earliest pass or a later one',
      (_label, poison) => {
        // 0 and 0.01 genuinely disagree (cap_rate's tolerance is 0.0025) — without the poisoned
        // vote, neither of the two real passes can reach MIN_AGREEING_PASSES alone.
        const poisonFirst = agreeFacts(
          [
            [capRateFact({ value: { amount: poison, unit: 'ratio' } })],
            [capRateFact({ value: { amount: 0, unit: 'ratio' } })],
            [capRateFact({ value: { amount: 0.01, unit: 'ratio' } })],
          ],
          METRIC_ONTOLOGY,
        );
        expect(poisonFirst.facts).toEqual([]);
        expect(poisonFirst.report.droppedGroups).toEqual([
          { factKey: capRateFact().factKey, agreeingPasses: 1, totalPasses: 2 },
        ]);
        expect(poisonFirst.report.unnormalizable).toHaveLength(1);
        expect(poisonFirst.report.unnormalizable[0].reason).toContain(`'${poison} ratio'`);

        const poisonLast = agreeFacts(
          [
            [capRateFact({ value: { amount: 0, unit: 'ratio' } })],
            [capRateFact({ value: { amount: 0.01, unit: 'ratio' } })],
            [capRateFact({ value: { amount: poison, unit: 'ratio' } })],
          ],
          METRIC_ONTOLOGY,
        );
        expect(poisonLast.facts).toEqual([]);
        expect(poisonLast.report.droppedGroups).toEqual([
          { factKey: capRateFact().factKey, agreeingPasses: 1, totalPasses: 2 },
        ]);
        expect(poisonLast.report.unnormalizable).toHaveLength(1);
      },
    );

    it('should not let a poisoned pivot manufacture agreement between two genuinely disagreeing finite votes', () => {
      // Trying every vote as pivot (`largestAgreeingCluster`'s own doc comment) means a poisoned
      // vote tried as pivot would, pre-fix, admit *every* vote in the group — not just
      // itself — since every comparison against it reads as non-conflicting. 0 and 0.05 are 20x
      // cap_rate's 0.0025 tolerance apart and must never read as agreeing with each other.
      const { facts, report } = agreeFacts(
        [
          [capRateFact({ value: { amount: NaN, unit: 'ratio' } })],
          [capRateFact({ value: { amount: 0, unit: 'ratio' } })],
          [capRateFact({ value: { amount: 0.05, unit: 'ratio' } })],
        ],
        METRIC_ONTOLOGY,
      );

      expect(facts).toEqual([]);
      expect(report.unnormalizable).toEqual([
        {
          fact: capRateFact({ value: { amount: NaN, unit: 'ratio' } }),
          reason:
            "value 'NaN ratio' does not convert to a safely comparable ratio value for metric 'cap_rate'",
        },
      ]);
    });

    it('should still elect the finite representative when a poisoned candidate rides along in the same group', () => {
      const { facts, report } = agreeFacts(
        [
          [capRateFact({ value: { amount: Infinity, unit: 'ratio' } })],
          [capRateFact({ value: { amount: 6.1, unit: 'percent' }, confidence: 0.9 })],
          [capRateFact({ value: { amount: 6.12, unit: 'percent' }, confidence: 0.8 })],
        ],
        METRIC_ONTOLOGY,
      );

      expect(facts).toHaveLength(1);
      expect(facts[0].value).toEqual({ amount: 6.1, unit: 'percent' });
      // Mean of only the two finite, agreeing passes — the poisoned pass never becomes a vote.
      expect(facts[0].confidence).toBeCloseTo(0.85, 10);
      expect(report.unnormalizable).toHaveLength(1);
      expect(report.unnormalizable[0].reason).toContain('Infinity');
    });

    it('should drop a group entirely when every candidate in it is poisoned, emitting no group at all', () => {
      const { facts, report } = agreeFacts(
        [
          [capRateFact({ value: { amount: NaN, unit: 'ratio' } })],
          [capRateFact({ value: { amount: Infinity, unit: 'ratio' } })],
          [capRateFact({ value: { amount: Number.MAX_SAFE_INTEGER + 2, unit: 'ratio' } })],
        ],
        METRIC_ONTOLOGY,
      );

      expect(facts).toEqual([]);
      expect(report.totalGroups).toBe(0);
      expect(report.droppedGroups).toEqual([]);
      expect(report.unnormalizable).toHaveLength(3);
    });

    it('should exclude a canonical value the unit conversion pushes past MAX_SAFE_INTEGER, even though the raw amount alone is safe', () => {
      // `sale_price`'s `usd_millions` unit has a `toCanonicalFactor` of `1_000_000` — an amount
      // comfortably inside `Number.MAX_SAFE_INTEGER` on its own can still convert to a canonical
      // value beyond it, so the guard has to inspect the converted value, not the raw amount.
      const overflowAmount = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000) + 10;
      expect(Number.isSafeInteger(overflowAmount)).toBe(true);

      const { facts, report } = agreeFacts(
        [
          [saleFact({ value: { amount: overflowAmount, unit: 'usd_millions' } })],
          [saleFact({ value: { amount: 41, unit: 'usd_millions' } })],
          [saleFact({ value: { amount: 41.2, unit: 'usd_millions' } })],
        ],
        METRIC_ONTOLOGY,
      );

      expect(facts).toHaveLength(1);
      expect(facts[0].value).toEqual({ amount: 41, unit: 'usd_millions' });
      expect(report.unnormalizable).toHaveLength(1);
      expect(report.unnormalizable[0].reason).toContain(
        'does not convert to a safely comparable usd value',
      );
    });
  });
});
