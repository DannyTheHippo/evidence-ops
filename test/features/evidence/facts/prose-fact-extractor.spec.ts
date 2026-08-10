import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { extractProseFacts } from '../../../../src/features/evidence/facts/prose-fact-extractor';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';

const CHUNK_LOCATOR: EvidenceLocator = { kind: 'pdf-page', page: 1, extractorVersion: 'v1' };

const page1: ParsedElement = {
  text: 'Executive Summary. Nothing about Northgate here.',
  locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
  headingPath: [],
};

const page2: ParsedElement = {
  text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.',
  locator: { kind: 'pdf-page', page: 2, extractorVersion: 'v1' },
  headingPath: [],
};

const CHUNK_TEXT = `${page1.text}\n\n${page2.text}`;

function buildProvider(): FakeModelProvider {
  return new FakeModelProvider();
}

describe('extractProseFacts', () => {
  let modelProvider: FakeModelProvider;

  beforeEach(() => {
    modelProvider = buildProvider();
  });

  it('should accept a candidate whose quote is verbatim in the chunk, and derive its period', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            metric: 'cap_rate',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'percent',
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toEqual({
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
      value: { amount: 6.1, unit: 'percent' },
      rawText: 'at a cap rate of approximately 6.10%',
      confidence: 0.9,
      extractionMethod: 'llm',
      locator: page2.locator,
    });
  });

  it('should narrow the locator to the specific page the quote came from, not the chunk anchor', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            metric: 'cap_rate',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'percent',
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR, // anchored at page 1
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted[0].locator).toEqual(page2.locator);
    expect(result.accepted[0].locator).not.toEqual(CHUNK_LOCATOR);
  });

  it('should reject and drop a candidate whose quote does not appear verbatim in the chunk', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            metric: 'cap_rate',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'percent',
            quote: 'a cap rate of roughly 6.10 percent', // paraphrased, not verbatim
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('quote not found verbatim');
  });

  it('should reject a candidate whose metric is not in the ontology', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            // Bypasses the schema's own z.enum allowlist (a live model cannot); exercises the
            // application-level fail-closed check that guards against schema/ontology drift.
            metric: 'invented_metric',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'percent',
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toContain('is not in the ontology');
  });

  it('should reject a candidate whose unit is not valid for its metric', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            metric: 'cap_rate',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'usd', // not a cap_rate unit
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toContain('is not valid for metric');
  });

  it('should fall back to the chunk locator when the quote matches more than one element', async () => {
    const repeated: ParsedElement = {
      ...page2,
      locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
    };
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Northgate Business Park',
            metric: 'cap_rate',
            periodText: 'March 2025',
            amount: 6.1,
            unit: 'percent',
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: `${page2.text}\n\n${repeated.text}`,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page2, repeated],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted[0].locator).toEqual(CHUNK_LOCATOR);
  });

  it('should derive the undated sentinel when periodText is empty', async () => {
    modelProvider.enqueueResult({
      output: {
        facts: [
          {
            entity: 'Sablewood Retail Court',
            metric: 'cap_rate',
            periodText: '',
            amount: 6.05,
            unit: 'percent',
            quote: 'at a cap rate of approximately 6.10%',
            confidence: 0.9,
          },
        ],
      },
    });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted[0].factKey.period).toBe('undated');
  });

  it('should pass the ontology-scoped system prompt and the chunk text as the user message', async () => {
    modelProvider.enqueueResult({ output: { facts: [] } });

    await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(modelProvider.calls).toHaveLength(1);
    expect(modelProvider.calls[0].taskClass).toBe('fact_extraction');
    expect(modelProvider.calls[0].messages).toEqual([{ role: 'user', content: CHUNK_TEXT }]);
    expect(modelProvider.calls[0].system).toContain('cap_rate');
  });
});
