import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { METRIC_ONTOLOGY } from '../../../../src/features/evidence/facts/metric-ontology';
import { extractProseFacts } from '../../../../src/features/evidence/facts/prose-fact-extractor';
import type { ParsedElement } from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';

const CHUNK_LOCATOR: EvidenceLocator = { kind: 'pdf-page', page: 1, extractorVersion: 'v1' };
const PASS_COUNT = 3;

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

/** Enqueues the same model output for all 3 passes — the common case exercised by most of this
 * suite: 3-of-3 unanimous agreement, so the multi-pass orchestration behaves like the old
 * single-pass code for every already-covered accept/reject scenario. */
function enqueueUnanimous(modelProvider: FakeModelProvider, facts: unknown[]): void {
  for (let i = 0; i < PASS_COUNT; i += 1) {
    modelProvider.enqueueResult({ output: { facts } });
  }
}

describe('extractProseFacts', () => {
  let modelProvider: FakeModelProvider;

  beforeEach(() => {
    modelProvider = buildProvider();
  });

  it('should accept a candidate whose quote is verbatim in the chunk, and derive its period', async () => {
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ]);

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
    expect(result.successfulPassCount).toBe(3);
    expect(result.skippedForInsufficientPasses).toBe(false);
  });

  it('should call the model 3 times, once per pass, with distinct passOrdinal values', async () => {
    enqueueUnanimous(modelProvider, []);

    await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(modelProvider.calls).toHaveLength(3);
    expect(modelProvider.calls.map((call) => call.passOrdinal)).toEqual([0, 1, 2]);
  });

  it('should narrow the locator to the specific page the quote came from, not the chunk anchor', async () => {
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ]);

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
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'a cap rate of roughly 6.10 percent', // paraphrased, not verbatim
        confidence: 0.9,
      },
    ]);

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted).toEqual([]);
    // Every one of the 3 (unanimous) passes independently rejects the same ungrounded candidate.
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason.includes('quote not found verbatim'))).toBe(true);
  });

  it('should reject a candidate whose metric is not in the ontology', async () => {
    enqueueUnanimous(modelProvider, [
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
    ]);

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
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'usd', // not a cap_rate unit
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ]);

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
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ]);

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
    enqueueUnanimous(modelProvider, [
      {
        entity: 'Sablewood Retail Court',
        metric: 'cap_rate',
        periodText: '',
        amount: 6.05,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ]);

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted[0].factKey.period).toBe('undated');
  });

  it('should pass the ontology-scoped system prompt and the chunk text as the user message, for every pass', async () => {
    enqueueUnanimous(modelProvider, []);

    await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(modelProvider.calls).toHaveLength(3);
    for (const call of modelProvider.calls) {
      expect(call.taskClass).toBe('fact_extraction');
      expect(call.messages).toEqual([{ role: 'user', content: CHUNK_TEXT }]);
      expect(call.system).toContain('cap_rate');
    }
  });

  it('should keep only the majority value when passes disagree, dropping the minority vote', async () => {
    const buildCandidate = (amount: number) => [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ];
    modelProvider.enqueueResult({ output: { facts: buildCandidate(6.1) } });
    modelProvider.enqueueResult({ output: { facts: buildCandidate(6.1) } });
    modelProvider.enqueueResult({ output: { facts: buildCandidate(9.9) } }); // outlier pass

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].value).toEqual({ amount: 6.1, unit: 'percent' });
  });

  it('should not count a throwing pass toward or against agreement, still accepting a fact 2 successful passes agree on', async () => {
    const candidate = [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ];
    modelProvider.enqueueResult({ output: { facts: candidate } });
    modelProvider.enqueueError(new Error('schema validation failed after retry'));
    modelProvider.enqueueResult({ output: { facts: candidate } });

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.successfulPassCount).toBe(2);
    expect(result.skippedForInsufficientPasses).toBe(false);
    expect(result.accepted).toHaveLength(1);
  });

  it('should skip the chunk entirely (visibly, not just empty) when fewer than 2 passes succeed', async () => {
    const candidate = [
      {
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        periodText: 'March 2025',
        amount: 6.1,
        unit: 'percent',
        quote: 'at a cap rate of approximately 6.10%',
        confidence: 0.9,
      },
    ];
    // Only 1 successful pass — even though it proposes a grounded, valid candidate, that single
    // sample must not be trusted as the answer.
    modelProvider.enqueueResult({ output: { facts: candidate } });
    modelProvider.enqueueError(new Error('schema validation failed after retry'));
    modelProvider.enqueueError(new Error('schema validation failed after retry'));

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.successfulPassCount).toBe(1);
    expect(result.skippedForInsufficientPasses).toBe(true);
    expect(result.accepted).toEqual([]);
  });

  it('should report no facts and no successful passes when every pass throws', async () => {
    modelProvider.enqueueError(new Error('boom'));
    modelProvider.enqueueError(new Error('boom'));
    modelProvider.enqueueError(new Error('boom'));

    const result = await extractProseFacts({
      chunkText: CHUNK_TEXT,
      chunkLocator: CHUNK_LOCATOR,
      sourceElements: [page1, page2],
      modelProvider,
      ontology: METRIC_ONTOLOGY,
    });

    expect(result.successfulPassCount).toBe(0);
    expect(result.skippedForInsufficientPasses).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.agreement).toEqual({
      totalGroups: 0,
      survivingFacts: 0,
      droppedGroups: [],
      unnormalizable: [],
    });
  });
});
