import {
  buildFactCandidateSchema,
  buildFactExtractionResultSchema,
} from '../../../../../src/features/evidence/facts/contracts/fact-extraction.contract';
import { METRIC_IDS } from '../../../../../src/features/evidence/facts/metric-ontology';

const factCandidateSchema = buildFactCandidateSchema(METRIC_IDS);
const factExtractionResultSchema = buildFactExtractionResultSchema(METRIC_IDS);

const validCandidate = {
  entity: 'Northgate Business Park',
  metric: 'cap_rate',
  periodText: 'March 2025',
  observedAtText: '2025-03-14',
  amount: 6.1,
  unit: 'percent',
  quote: 'at a cap rate of approximately 6.10%',
  confidence: 0.9,
};

describe('factCandidateSchema', () => {
  it('should accept a valid candidate', () => {
    expect(factCandidateSchema.safeParse(validCandidate).success).toBe(true);
  });

  it('should reject a metric id outside the ontology allowlist — this is the enforcement point', () => {
    const result = factCandidateSchema.safeParse({ ...validCandidate, metric: 'invented_metric' });

    expect(result.success).toBe(false);
  });

  it('should reject a quote longer than 300 characters', () => {
    const result = factCandidateSchema.safeParse({ ...validCandidate, quote: 'x'.repeat(301) });

    expect(result.success).toBe(false);
  });

  it('should accept a quote at exactly the 300 character limit', () => {
    const result = factCandidateSchema.safeParse({ ...validCandidate, quote: 'x'.repeat(300) });

    expect(result.success).toBe(true);
  });

  it('should reject an empty quote', () => {
    expect(factCandidateSchema.safeParse({ ...validCandidate, quote: '' }).success).toBe(false);
  });

  it('should reject a confidence outside [0, 1]', () => {
    expect(factCandidateSchema.safeParse({ ...validCandidate, confidence: 1.5 }).success).toBe(
      false,
    );
    expect(factCandidateSchema.safeParse({ ...validCandidate, confidence: -0.1 }).success).toBe(
      false,
    );
  });

  it('should accept an empty periodText for a source that states no period', () => {
    expect(factCandidateSchema.safeParse({ ...validCandidate, periodText: '' }).success).toBe(true);
  });

  it('should accept an empty observedAtText for a source that states no observation date', () => {
    expect(factCandidateSchema.safeParse({ ...validCandidate, observedAtText: '' }).success).toBe(
      true,
    );
  });

  it('should reject a candidate missing observedAtText entirely', () => {
    expect(
      factCandidateSchema.safeParse({ ...validCandidate, observedAtText: undefined }).success,
    ).toBe(false);
  });
});

describe('buildFactCandidateSchema', () => {
  it("should accept a metric outside the CRE ontology's ids when a different pack's ids are passed", () => {
    const customSchema = buildFactCandidateSchema(['occupancy_rate']);

    const result = customSchema.safeParse({ ...validCandidate, metric: 'occupancy_rate' });

    expect(result.success).toBe(true);
  });

  it('should reject a CRE metric id once a differently-scoped pack no longer allowlists it', () => {
    const customSchema = buildFactCandidateSchema(['occupancy_rate']);

    const result = customSchema.safeParse(validCandidate);

    expect(result.success).toBe(false);
  });
});

describe('factExtractionResultSchema', () => {
  it('should accept an empty facts array', () => {
    expect(factExtractionResultSchema.safeParse({ facts: [] }).success).toBe(true);
  });

  it('should accept multiple valid candidates', () => {
    const result = factExtractionResultSchema.safeParse({
      facts: [
        validCandidate,
        { ...validCandidate, metric: 'sale_price', unit: 'usd', amount: 41_000_000 },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('should reject when any one candidate is invalid', () => {
    const result = factExtractionResultSchema.safeParse({
      facts: [validCandidate, { ...validCandidate, metric: 'not_a_real_metric' }],
    });

    expect(result.success).toBe(false);
  });
});
