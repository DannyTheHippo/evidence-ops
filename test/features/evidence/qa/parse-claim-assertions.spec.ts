import type { CanonicalEntityListing } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { extractNumericTokenMatches } from '../../../../src/features/evidence/qa/extract-numeric-tokens';
import {
  parseClaimAssertions,
  type UnitKind,
} from '../../../../src/features/evidence/qa/parse-claim-assertions';
import type { VerifierMeasure } from '../../../../src/features/evidence/qa/types/verifier-measure.type';

describe('parseClaimAssertions', () => {
  describe('date masking', () => {
    // Every date form `derive-period.ts`'s `MATCHERS` accepts, plus a bare year — each must yield
    // exactly one period and must not leak any of its own digits into `numbers`.
    it.each([
      '2025-07-15',
      'July 15, 2025',
      '15 July 2025',
      '2025-07',
      'Q3 2025',
      '2025 Q3',
      'FY2025',
      'July 2025',
      'in 2025',
    ])('should mask %p to one period with no date digits reaching numbers', (dateForm) => {
      const statement = `The property closed ${dateForm} for $500,000.`;

      const result = parseClaimAssertions({ statement, measures: [], entities: [] });

      expect(result.periods).toHaveLength(1);
      expect(result.numbers).toHaveLength(1);
      expect(result.numbers[0].canonicalValue).toBeCloseTo(500_000, 4);
      expect(result.maskedStatement).toHaveLength(statement.length);
    });
  });

  describe('unit table', () => {
    it.each<[string, UnitKind, number]>([
      ['$46.9 million', 'currency', 46_900_000],
      ['4.55%', 'percentage', 0.0455],
      ['25 bps', 'percentage', 0.0025],
      ['174,200 SF', 'area', 174_200],
      ['five years', 'duration', 5],
      ['12 months', 'duration', 1],
      ['3 stories', 'unknown', 3],
    ])(
      'should classify %p as %s with canonical value %p',
      (statement, unitKind, canonicalValue) => {
        const result = parseClaimAssertions({ statement, measures: [], entities: [] });

        expect(result.numbers).toHaveLength(1);
        expect(result.numbers[0].unitKind).toBe(unitKind);
        expect(result.numbers[0].canonicalValue).toBeCloseTo(canonicalValue, 4);
      },
    );
  });

  it('should extract the ADR-0024 c001 canonical values and one period', () => {
    const statement =
      'Northgate Business Park sold on 2025-07-15 for $46,900,000, or $269.34 per square foot, ' +
      'at a 4.55% cap rate, with net operating income of $2,134,450.';

    const result = parseClaimAssertions({ statement, measures: [], entities: [] });

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].key).toBe('2025-07');
    expect(result.numbers.map((n) => n.canonicalValue)).toEqual([
      expect.closeTo(46_900_000, 4),
      expect.closeTo(269.34, 4),
      expect.closeTo(0.0455, 4),
      expect.closeTo(2_134_450, 4),
    ]);
  });

  describe('entity and measure mentions', () => {
    const NORTHGATE: CanonicalEntityListing = {
      canonicalName: 'Northgate Business Park',
      canonicalNameNormalized: 'northgate business park',
      aliasesNormalized: ['ngbp'],
    };
    const CAP_RATE: VerifierMeasure = {
      slug: 'cap_rate',
      label: 'Cap Rate',
      aliases: ['capitalization rate'],
      valueType: 'percentage',
      canonicalUnit: 'ratio',
      units: [{ id: 'ratio', toCanonicalFactor: 1 }],
      toleranceKind: 'relative',
      tolerance: 0.01,
    };

    it('should record an entity mention reached only through its alias', () => {
      const result = parseClaimAssertions({
        statement: 'NGBP sold for $1,000,000.',
        measures: [],
        entities: [NORTHGATE],
      });

      expect(result.entityMentions).toEqual(new Set(['northgate business park']));
    });

    it('should record a measure mention reached through its alias, case-insensitively', () => {
      const result = parseClaimAssertions({
        statement: 'The CAPITALIZATION RATE was 4.55%.',
        measures: [CAP_RATE],
        entities: [],
      });

      expect(result.measureMentions).toEqual(new Set(['cap_rate']));
    });

    it('should record no mention when neither name nor alias occurs as a whole token', () => {
      const result = parseClaimAssertions({
        statement: 'Cedar Bluff sold for $1,000,000.',
        measures: [CAP_RATE],
        entities: [NORTHGATE],
      });

      expect(result.entityMentions.size).toBe(0);
      expect(result.measureMentions.size).toBe(0);
    });
  });

  describe('adversarial unicode forms', () => {
    // Neither form must invent a number `extractNumericTokenMatches` would not itself produce over
    // the same (period-masked) text — the two symptoms a hostile document could otherwise trigger:
    // a zero-width space splitting a digit run, and a homoglyph letter nearby confusing tokenizing.
    it('should not introduce a phantom number when a zero-width space splits a digit run', () => {
      const statement = 'The price was $46,900,​000 as reported.';

      const result = parseClaimAssertions({ statement, measures: [], entities: [] });

      const expectedValues = extractNumericTokenMatches(statement.normalize('NFKC')).map(
        (match) => match.value,
      );
      expect(result.numbers.map((n) => n.value)).toEqual(expectedValues);
    });

    it('should not introduce a phantom number when a Cyrillic homoglyph replaces a Latin letter nearby', () => {
      const statement = 'Nоrgate sold for $46,900,000 in total.'; // 'о' (U+043E) is Cyrillic

      const result = parseClaimAssertions({ statement, measures: [], entities: [] });

      const expectedValues = extractNumericTokenMatches(statement.normalize('NFKC')).map(
        (match) => match.value,
      );
      expect(result.numbers.map((n) => n.value)).toEqual(expectedValues);
    });
  });
});
