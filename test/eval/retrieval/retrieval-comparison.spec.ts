import type { mongo } from 'mongoose';
import { runRetrievalComparison } from '../../../eval/retrieval/retrieval-comparison';
import type { ModeRetrievalHit, RetrievalMode } from '../../../eval/retrieval/retrieval-modes';
import type { EvalCase } from '../../../eval/dataset/schema';
import { resolveLocatorText } from '../../../eval/resolve-locator';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';

function makeCase(overrides: Partial<EvalCase> & Pick<EvalCase, 'expectedLocators'>): EvalCase {
  return {
    id: 'ans-001',
    category: 'answerable',
    question: 'What is the premises description in the lease abstract?',
    expectedAnswerContains: ['Northgate'],
    expectedOutcome: 'answer',
    notes: 'test fixture',
    ...overrides,
  };
}

describe('runRetrievalComparison', () => {
  const db = {} as mongo.Db;
  const filenameByDocVersionId = new Map([['docver-1', 'lease-summary.docx']]);

  // Regression guard for the defect where every candidate chunk was built with a fabricated
  // `text: ''`: `chunkOverlapsLocator`'s pdf-page/docx-paragraph branches match by text
  // containment, so an empty string can never satisfy them, and only `xlsx-cell` locators
  // (matched structurally by cell address, not text) could ever score. This asserts a
  // docx-paragraph case scores using the hit's *real* chunk text — it fails against a `search`
  // stub that reverts to fabricating empty text, exactly as the old `run.ts` code did.
  it("should score a docx-paragraph locator case using the hit's real chunk text", async () => {
    const locator: EvalCase['expectedLocators'][number] = {
      kind: 'docx-paragraph',
      file: 'lease-summary.docx',
      paragraphIndex: 3,
      headingPath: ['Lease Abstract — Northgate Business Park', 'Premises'],
    };
    const chunkText = await resolveLocatorText(locator);
    expect(chunkText.trim()).not.toBe('');

    const hit: ModeRetrievalHit = {
      chunkId: 'chunk-1',
      documentVersionId: 'docver-1',
      text: chunkText,
      locator: {
        kind: 'docx-paragraph',
        paragraphIndex: 3,
        headingPath: locator.headingPath,
        extractorVersion: 'test',
      },
    };
    const search = jest.fn(
      (
        _db: mongo.Db,
        _embeddingProvider: unknown,
        _mode: RetrievalMode,
        _query: unknown,
      ): Promise<ModeRetrievalHit[]> => Promise.resolve([hit]),
    );

    const summaries = await runRetrievalComparison({
      db,
      embeddingProvider: new FakeEmbeddingProvider(),
      filenameByDocVersionId,
      cases: [makeCase({ expectedLocators: [locator] })],
      tenantId: 'eval',
      search,
    });

    expect(search).toHaveBeenCalledTimes(3); // once per retrieval mode
    for (const summary of summaries) {
      expect(summary.recallAt10).toBe(1);
      expect(summary.caseCount).toBe(1);
      expect(summary.totalCases).toBe(1);
    }
  });

  it('should exclude a zero-hit case from caseCount while keeping it in totalCases', async () => {
    const locator: EvalCase['expectedLocators'][number] = {
      kind: 'docx-paragraph',
      file: 'lease-summary.docx',
      paragraphIndex: 3,
      headingPath: ['Lease Abstract — Northgate Business Park', 'Premises'],
    };
    const search = jest.fn(
      (
        _db: mongo.Db,
        _embeddingProvider: unknown,
        _mode: RetrievalMode,
        _query: unknown,
      ): Promise<ModeRetrievalHit[]> => Promise.resolve([]),
    );

    const summaries = await runRetrievalComparison({
      db,
      embeddingProvider: new FakeEmbeddingProvider(),
      filenameByDocVersionId,
      cases: [makeCase({ expectedLocators: [locator] })],
      tenantId: 'eval',
      search,
    });

    for (const summary of summaries) {
      expect(summary.caseCount).toBe(0);
      expect(summary.totalCases).toBe(1);
    }
  });

  it('should default to the real searchByMode when no search override is provided', async () => {
    // Safe without live Mongo: `cases: []` means no locator-bearing case exists, so the inner loop
    // that would call the real `searchByMode` never executes for any mode.
    await expect(
      runRetrievalComparison({
        db,
        embeddingProvider: new FakeEmbeddingProvider(),
        filenameByDocVersionId,
        cases: [],
        tenantId: 'eval',
      }),
    ).resolves.toEqual([
      { mode: 'lexical', recallAt5: 0, recallAt10: 0, mrr: 0, caseCount: 0, totalCases: 0 },
      { mode: 'vector', recallAt5: 0, recallAt10: 0, mrr: 0, caseCount: 0, totalCases: 0 },
      { mode: 'hybrid', recallAt5: 0, recallAt10: 0, mrr: 0, caseCount: 0, totalCases: 0 },
    ]);
  });

  // Regression pin for the unflagged `npm run eval` path: `modes` must default to exactly the
  // three Mongo modes, in this order, so a future change to the Qdrant benchmark wiring can never
  // silently widen (or reorder) what an unflagged run scores.
  it('should default `modes` to exactly the three Mongo modes, in order, when omitted', async () => {
    const search = jest.fn(
      (
        _db: mongo.Db,
        _embeddingProvider: unknown,
        _mode: RetrievalMode,
        _query: unknown,
      ): Promise<ModeRetrievalHit[]> => Promise.resolve([]),
    );

    const summaries = await runRetrievalComparison({
      db,
      embeddingProvider: new FakeEmbeddingProvider(),
      filenameByDocVersionId,
      cases: [],
      tenantId: 'eval',
      search,
    });

    expect(summaries.map((summary) => summary.mode)).toEqual(['lexical', 'vector', 'hybrid']);
  });

  it('should score every mode passed in `modes`, in order, including a non-Mongo mode', async () => {
    const modes: RetrievalMode[] = ['lexical', 'vector', 'hybrid', 'qdrant-vector'];
    const search = jest.fn(
      (
        _db: mongo.Db,
        _embeddingProvider: unknown,
        _mode: RetrievalMode,
        _query: unknown,
      ): Promise<ModeRetrievalHit[]> => Promise.resolve([]),
    );

    const summaries = await runRetrievalComparison({
      db,
      embeddingProvider: new FakeEmbeddingProvider(),
      filenameByDocVersionId,
      cases: [],
      tenantId: 'eval',
      modes,
      search,
    });

    expect(summaries.map((summary) => summary.mode)).toEqual(modes);
  });
});
