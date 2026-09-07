import { normalizeEntityName } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { parseClaimAssertions } from '../../../../src/features/evidence/qa/parse-claim-assertions';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { VerifierMeasure } from '../../../../src/features/evidence/qa/types/verifier-measure.type';
import type { GroundingCellFact } from '../../../../src/features/evidence/qa/verify-claim';
import { verifyStructuredSupport } from '../../../../src/features/evidence/qa/verify-structured-support';

const SHA256_A = 'a'.repeat(64);
const XLSX_CELL_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-cell',
  extractorVersion: 'v1',
  sheetName: 'Comps',
  cell: 'B7',
};
const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };

// The eight seed measures (`metric-ontology.ts`), projected to `VerifierMeasure` exactly as
// `MeasuresService` will project a tenant's confirmed `Measure` rows in 2.13.
const ALL_MEASURES: readonly VerifierMeasure[] = METRIC_ONTOLOGY.map((metric) => ({
  slug: metric.id,
  label: metric.label,
  aliases: metric.aliases,
  valueType: metric.valueType,
  canonicalUnit: metric.canonicalUnit,
  units: metric.units,
  toleranceKind: metric.toleranceKind,
  tolerance: metric.tolerance,
}));

const NORTHGATE = 'Northgate Business Park';
const SUBJECT_NORTHGATE = new Set([normalizeEntityName(NORTHGATE)]);

function buildAssertions(statement: string, measures: readonly VerifierMeasure[] = ALL_MEASURES) {
  return parseClaimAssertions({ statement, measures, entities: [] });
}

function buildChunk(
  overrides: Partial<RetrievedChunk> & { chunkId: string; text: string },
): RetrievedChunk {
  return {
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    locator: PDF_LOCATOR,
    ...overrides,
  };
}

describe('verifyStructuredSupport', () => {
  describe('the ADR-0024 c001 row', () => {
    const C001_CHUNK = buildChunk({
      chunkId: 'chunk-c001',
      text: 'Northgate Business Park comps row.',
      locator: XLSX_CELL_LOCATOR,
    });
    const C001_FACTS: readonly GroundingCellFact[] = [
      {
        chunkId: C001_CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'sale_price', period: '2025-07' },
        value: { amount: 46_900_000, unit: 'usd' },
        locator: XLSX_CELL_LOCATOR,
      },
      {
        chunkId: C001_CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'price_per_sf', period: '2025-07' },
        value: { amount: 269.34, unit: 'usd_per_sf' },
        locator: XLSX_CELL_LOCATOR,
      },
      {
        chunkId: C001_CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: '2025-07' },
        value: { amount: 4.55, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      },
      {
        chunkId: C001_CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'net_operating_income', period: '2025-07' },
        value: { amount: 2_134_450, unit: 'usd' },
        locator: XLSX_CELL_LOCATOR,
      },
    ];
    const C001_STATEMENT =
      'Northgate Business Park sold on 2025-07-15 for $46,900,000, or $269.34 per square foot, ' +
      'at a 4.55% cap rate, with net operating income of $2,134,450.';

    it('should support every assertion, including its date', () => {
      const assertions = buildAssertions(C001_STATEMENT);

      const result = verifyStructuredSupport({
        statement: C001_STATEMENT,
        assertions,
        citedChunks: [C001_CHUNK],
        cellFacts: C001_FACTS,
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
      expect(result.supportingFacts.map((fact) => fact.factKey.metric).sort()).toEqual(
        ['cap_rate', 'net_operating_income', 'price_per_sf', 'sale_price'].sort(),
      );
    });
  });

  it('should support "$46.9 million" against a sale_price fact within 1% tolerance', () => {
    const statement = 'Northgate Business Park sold for $46.9 million.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Sale Price (USD): 46900000',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'sale_price', period: 'undated' },
      value: { amount: 46_900_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toEqual([]);
  });

  it.each<[string, string, number]>([
    ['ratio', 'ratio', 0.0455],
    ['percent', 'percent', 4.55],
  ])('should support "4.55%%" against a cap_rate fact stored in %s', (_label, unit, amount) => {
    const statement = 'The cap rate is 4.55%.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Cap Rate: 4.55%',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
      value: { amount, unit },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toEqual([]);
  });

  it('should try both scale 1 and 0.01 for a bare number matched against a mentioned percentage measure', () => {
    const statement = 'The cap rate is 4.55.';
    const assertions = buildAssertions(statement);
    expect(assertions.numbers[0].unitKind).toBe('unknown');
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Cap Rate: 4.55%',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
      value: { amount: 4.55, unit: 'percent' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toEqual([]);
  });

  it('should not support "25 bps" against a cap_rate fact of 4.55%', () => {
    const statement = 'The cap rate is 25 bps.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Cap Rate: 4.55%',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
      value: { amount: 4.55, unit: 'percent' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });

  describe('tolerance boundaries', () => {
    // `cap_rate`'s absolute tolerance is 0.0025 (25bp). Percentage decimals are not exactly
    // representable in binary floating point, so this pair checks comfortably inside and clearly
    // outside the boundary rather than at an exact ULP — the relative-tolerance pair below (all
    // integer amounts) checks the exact `<=` boundary itself.
    it('should support a cap_rate claim comfortably inside its absolute tolerance', () => {
      const statement = 'The cap rate is 4.70%.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Cap Rate: 4.55%',
        locator: XLSX_CELL_LOCATOR,
      });
      const fact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
        value: { amount: 4.55, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });

    it('should not support a cap_rate claim clearly outside its absolute tolerance', () => {
      const statement = 'The cap rate is 4.90%.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Cap Rate: 4.55%',
        locator: XLSX_CELL_LOCATOR,
      });
      const fact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
        value: { amount: 4.55, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toHaveLength(1);
    });

    // `sale_price`'s relative tolerance is 1% of the larger magnitude; every amount below is an
    // integer, so the boundary compares exactly with no floating-point slack.
    it('should support a sale_price claim exactly at its relative tolerance boundary', () => {
      const statement = 'Northgate Business Park sold for $46,431,000.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Sale Price (USD): 46900000',
        locator: XLSX_CELL_LOCATOR,
      });
      const fact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'sale_price', period: 'undated' },
        value: { amount: 46_900_000, unit: 'usd' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });

    it('should not support a sale_price claim one dollar beyond its relative tolerance boundary', () => {
      const statement = 'Northgate Business Park sold for $46,430,999.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Sale Price (USD): 46900000',
        locator: XLSX_CELL_LOCATOR,
      });
      const fact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'sale_price', period: 'undated' },
        value: { amount: 46_900_000, unit: 'usd' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toHaveLength(1);
    });
  });

  it("should not support a number when the bound fact's entity does not match the claim's subject, even at an equal value", () => {
    const statement = 'The property sold for $41,000,000.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Sale Price (USD): 41000000',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'sale_price', period: 'undated' },
      value: { amount: 41_000_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
  });

  it('should report period-claim-unsupported when the claim states a period no bound fact or eligible text matches', () => {
    const statement = 'In 2019, Northgate Business Park operated normally.';
    const assertions = buildAssertions(statement);
    expect(assertions.numbers).toEqual([]);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Northgate Business Park cap rate 4.55%.',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'cap_rate', period: '2025-07' },
      value: { amount: 4.55, unit: 'percent' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: 'period-claim-unsupported' }),
    );
  });

  describe('the fiscal-year overlap trap', () => {
    const STATEMENT = 'In FY2025, Northgate Business Park reported strong performance.';
    const CHUNK = buildChunk({
      chunkId: 'chunk-1',
      text: 'Northgate Business Park cap rate 4.55%.',
      locator: XLSX_CELL_LOCATOR,
    });

    it('should support a stated FY2025 against a fact keyed FY2025 via key equality alone', () => {
      const assertions = buildAssertions(STATEMENT);
      const fact: GroundingCellFact = {
        chunkId: CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'FY2025' },
        value: { amount: 4.55, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement: STATEMENT,
        assertions,
        citedChunks: [CHUNK],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });

    it('should not support a stated FY2025 against a fact keyed to the calendar year 2025 — periodsOverlap fails closed on a fiscal-year key', () => {
      const assertions = buildAssertions(STATEMENT);
      const fact: GroundingCellFact = {
        chunkId: CHUNK.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: '2025' },
        value: { amount: 4.55, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement: STATEMENT,
        assertions,
        citedChunks: [CHUNK],
        cellFacts: [fact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({ kind: 'period-claim-unsupported' }),
      );
    });
  });

  it('should support a stated period through any cited, entity-bound fact carrying it, not only one that also bound a number', () => {
    const statement = 'In 2025-07, Northgate Business Park changed hands.';
    const assertions = buildAssertions(statement);
    expect(assertions.numbers).toEqual([]);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Net Operating Income (USD): 2134450',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'net_operating_income', period: '2025-07' },
      value: { amount: 2_134_450, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toEqual([]);
  });

  describe('R4: the fallback asymmetry', () => {
    // A measure-bound number (has a candidate measure) never falls back to raw chunk text once
    // the cited chunk carries any cell fact at all — the invariant this module exists to restore.
    it('should not fall back to raw chunk text for a measure-bound number on a chunk carrying cell facts', () => {
      const statement = 'Northgate Business Park sold for $500,000.';
      const assertions = buildAssertions(statement);
      expect(assertions.numbers[0].unitKind).toBe('currency');
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Northgate Business Park comps row: cap rate 6.1%, listed at $500,000 elsewhere on the sheet.',
        locator: XLSX_CELL_LOCATOR,
      });
      const unrelatedFact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
        value: { amount: 6.1, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [unrelatedFact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({ kind: 'numeric-claim-unsupported' }),
      );
    });

    it('should fall back to raw chunk text for an unbound (unitless) number even when the chunk carries cell facts', () => {
      const statement = 'Northgate Business Park has 3 stories.';
      const assertions = buildAssertions(statement);
      expect(assertions.numbers[0].unitKind).toBe('unknown');
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Northgate Business Park comps row: cap rate 6.1%. The building has 3 stories.',
        locator: XLSX_CELL_LOCATOR,
      });
      const unrelatedFact: GroundingCellFact = {
        chunkId: chunk.chunkId,
        factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
        value: { amount: 6.1, unit: 'percent' },
        locator: XLSX_CELL_LOCATOR,
      };

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [unrelatedFact],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });

    it('should fall back to raw chunk text for an unbound number on a chunk with no cell facts at all', () => {
      const statement = 'Northgate Business Park has 3 stories.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({
        chunkId: 'chunk-1',
        text: 'Northgate Business Park is a three-story office building with 3 stories of leasable space.',
      });

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });

    it('should refuse the raw-text fallback when the cited chunk does not name the known subject entity, with subjectBinding on', () => {
      const statement = 'Northgate Business Park has 3 stories.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({ chunkId: 'chunk-1', text: 'The building has 3 stories.' });

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
        subjectBinding: true,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({ kind: 'numeric-claim-unsupported' }),
      );
    });

    it('should allow the raw-text fallback for a chunk that does not name the subject entity, with subjectBinding off (default)', () => {
      const statement = 'Northgate Business Park has 3 stories.';
      const assertions = buildAssertions(statement);
      const chunk = buildChunk({ chunkId: 'chunk-1', text: 'The building has 3 stories.' });

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [chunk],
        cellFacts: [],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
      });

      expect(result.violations).toEqual([]);
    });
  });

  describe('subjectBinding and the lease-preamble case', () => {
    // A lease names its property once in the preamble and thereafter says "the Premises" — a
    // legitimately-relevant chunk this far into the document never repeats the entity name, but it
    // does still carry the claimed number in raw text.
    const LEASE_CHUNK = buildChunk({
      chunkId: 'chunk-lease',
      text: 'The Premises shall have a base rent of $41,000,000 per annum, payable monthly.',
    });

    it.each([[undefined], [false]])(
      'should support a lease-preamble number when the cited chunk does not name the entity, with subjectBinding %s',
      (subjectBinding) => {
        const statement = 'The lease has a base rent of $41,000,000.';
        const assertions = buildAssertions(statement);

        const result = verifyStructuredSupport({
          statement,
          assertions,
          citedChunks: [LEASE_CHUNK],
          cellFacts: [],
          measures: ALL_MEASURES,
          subjectEntities: SUBJECT_NORTHGATE,
          subjectBinding,
        });

        expect(result.violations).toEqual([]);
      },
    );

    it('should refuse the same lease-preamble number once subjectBinding is on', () => {
      const statement = 'The lease has a base rent of $41,000,000.';
      const assertions = buildAssertions(statement);

      const result = verifyStructuredSupport({
        statement,
        assertions,
        citedChunks: [LEASE_CHUNK],
        cellFacts: [],
        measures: ALL_MEASURES,
        subjectEntities: SUBJECT_NORTHGATE,
        subjectBinding: true,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({ kind: 'numeric-claim-unsupported' }),
      );
    });
  });

  describe('R1 fact binding survives subjectBinding off', () => {
    // The wrong-entity class: with `subjectBinding` off, a cell fact keyed to a different entity
    // must still never support a number in this claim, at equal value — R1's binding
    // (`findBoundFact`'s `subjectEntities.has(...)` check) is unconditional, not gated by the flag.
    it.each<[string, number]>([
      ['Cedar Bluff Logistics Center', 41_000_000],
      ['Sablewood Retail Plaza', 41_000_000],
    ])(
      "should not support a number when the bound fact's entity (%s) does not match the claim's subject, even at an equal value, with subjectBinding off",
      (otherEntity, amount) => {
        const statement = 'The property sold for $41,000,000.';
        const assertions = buildAssertions(statement);
        const chunk = buildChunk({
          chunkId: 'chunk-1',
          text: 'Sale Price (USD): 41000000',
          locator: XLSX_CELL_LOCATOR,
        });
        const fact: GroundingCellFact = {
          chunkId: chunk.chunkId,
          factKey: { entity: otherEntity, metric: 'sale_price', period: 'undated' },
          value: { amount, unit: 'usd' },
          locator: XLSX_CELL_LOCATOR,
        };

        const result = verifyStructuredSupport({
          statement,
          assertions,
          citedChunks: [chunk],
          cellFacts: [fact],
          measures: ALL_MEASURES,
          subjectEntities: SUBJECT_NORTHGATE,
          subjectBinding: false,
        });

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].kind).toBe('numeric-claim-unsupported');
      },
    );
  });

  it('should not let a fact whose unit its measure does not declare support anything', () => {
    const statement = 'The cap rate is 6.1%.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Northgate Business Park cap rate 6.1%.',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      // cap_rate only declares `ratio` and `percent` — `sf` is a foreign unit vocabulary entirely.
      factKey: { entity: NORTHGATE, metric: 'cap_rate', period: 'undated' },
      value: { amount: 6.1, unit: 'sf' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: 'numeric-claim-unsupported' }),
    );
    expect(result.supportingFacts).toEqual([]);
  });

  it('should report numeric-claim-unsupported for an unrepresentable digit run regardless of every other number binding', () => {
    const statement = 'Northgate Business Park sold for $46,900,000 and carries parcel ID ١٢٢٠٠.';
    const assertions = buildAssertions(statement);
    const chunk = buildChunk({
      chunkId: 'chunk-1',
      text: 'Sale Price (USD): 46900000',
      locator: XLSX_CELL_LOCATOR,
    });
    const fact: GroundingCellFact = {
      chunkId: chunk.chunkId,
      factKey: { entity: NORTHGATE, metric: 'sale_price', period: 'undated' },
      value: { amount: 46_900_000, unit: 'usd' },
      locator: XLSX_CELL_LOCATOR,
    };

    const result = verifyStructuredSupport({
      statement,
      assertions,
      citedChunks: [chunk],
      cellFacts: [fact],
      measures: ALL_MEASURES,
      subjectEntities: SUBJECT_NORTHGATE,
    });

    const violation = result.violations.find(
      (candidate) => candidate.kind === 'numeric-claim-unsupported',
    );
    expect(violation?.detail).toContain('cannot represent');
  });
});
