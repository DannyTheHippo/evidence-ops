import type { EvalCase, Locator } from '../../../eval/dataset/schema';
import type { OverlapCandidateChunk } from '../../../eval/metrics/locator-overlap';
import { resolveLocatorText } from '../../../eval/resolve-locator';
import {
  assertCorpusFingerprintMatches,
  assertEveryCaseObserved,
  assertRetrievedChunksResolve,
  buildCorpusChunkById,
  computeRecallForPass,
  findUnmatchedLocators,
  isWithinSpread,
  recallFromVariance,
  type CorpusChunkRow,
} from '../../../eval/variance/recall-from-observations';
import type { VarianceCaseRun } from '../../../eval/variance/variance-report';

function pdfChunk(filename: string, page: number): OverlapCandidateChunk {
  const locator = { kind: 'pdf-page' as const, page, extractorVersion: 'v1' };
  return {
    filename,
    text: `text on page ${page}`,
    locator,
    elements: [{ locator, text: `text on page ${page}` }],
  };
}

function pdfLocator(file: string, page: number): Locator {
  return { kind: 'pdf-page', file, page };
}

function observation(
  caseId: string,
  runIndex: number,
  retrievedChunkIds: readonly string[],
): VarianceCaseRun {
  return {
    runIndex,
    caseId,
    question: 'q',
    outcomeKind: 'answered',
    citedChunkIds: [],
    claimCount: 0,
    retrievedChunkIds,
    citations: [],
  };
}

function evalCase(id: string, expectedLocators: readonly Locator[]): EvalCase {
  return {
    id,
    category: expectedLocators.length > 0 ? 'answerable' : 'unanswerable',
    question: 'q',
    expectedLocators: [...expectedLocators],
    expectedAnswerContains: expectedLocators.length > 0 ? ['x'] : undefined,
    expectedOutcome: expectedLocators.length > 0 ? 'answer' : 'abstain',
    notes: 'n',
  };
}

describe('assertRetrievedChunksResolve', () => {
  it('should not throw when every retrieved chunk id resolves against the corpus', () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);

    expect(() =>
      assertRetrievedChunksResolve([observation('ans-001', 1, ['c1'])], corpusChunkById),
    ).not.toThrow();
  });

  it('should throw naming every missing chunk id and the count, deduped across observations', () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);
    const observations = [
      observation('ans-001', 1, ['c1', 'c2']),
      observation('ans-001', 2, ['c2', 'c3']),
    ];

    expect(() => assertRetrievedChunksResolve(observations, corpusChunkById)).toThrow(
      /2 retrieved chunk id\(s\).*c2, c3/s,
    );
  });
});

describe('assertEveryCaseObserved', () => {
  it('should not throw when every dataset case has at least one observation', () => {
    const cases = [evalCase('ans-001', [pdfLocator('f.pdf', 1)])];

    expect(() => assertEveryCaseObserved(cases, [observation('ans-001', 1, ['c1'])])).not.toThrow();
  });

  it('should throw naming every dataset case with no observation in the result', () => {
    const cases = [
      evalCase('ans-001', [pdfLocator('f.pdf', 1)]),
      evalCase('ans-002', [pdfLocator('f.pdf', 2)]),
    ];

    expect(() => assertEveryCaseObserved(cases, [observation('ans-001', 1, ['c1'])])).toThrow(
      /1 dataset case\(s\).*ans-002/s,
    );
  });
});

describe('computeRecallForPass', () => {
  const expected = [pdfLocator('f.pdf', 3)];

  it('should score a hit within the top 5 as present in both recall@5 and recall@10', async () => {
    const corpusChunkById = new Map([
      ['c1', pdfChunk('f.pdf', 1)],
      ['c2', pdfChunk('f.pdf', 2)],
      ['c3', pdfChunk('f.pdf', 3)],
      ['c4', pdfChunk('f.pdf', 4)],
    ]);
    const cases = [evalCase('ans-001', expected)];
    const observations = [observation('ans-001', 1, ['c1', 'c2', 'c3', 'c4'])];

    const { recall } = await computeRecallForPass(1, observations, cases, corpusChunkById);

    expect(recall.recallAt5).toBe(1);
    expect(recall.recallAt10).toBe(1);
    expect(recall.caseCount).toBe(1);
  });

  it('should score a hit beyond rank 5 as absent from recall@5 but present in recall@10', async () => {
    const corpusChunkById = new Map([
      ['c1', pdfChunk('f.pdf', 1)],
      ['c2', pdfChunk('f.pdf', 1)],
      ['c3', pdfChunk('f.pdf', 1)],
      ['c4', pdfChunk('f.pdf', 1)],
      ['c5', pdfChunk('f.pdf', 1)],
      ['c6', pdfChunk('f.pdf', 3)],
    ]);
    const cases = [evalCase('ans-001', expected)];
    const observations = [observation('ans-001', 1, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])];

    const { recall } = await computeRecallForPass(1, observations, cases, corpusChunkById);

    expect(recall.recallAt5).toBe(0);
    expect(recall.recallAt10).toBe(1);
  });

  it('should exclude a case with no expected locators from the recall denominator', async () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);
    const cases = [evalCase('ans-001', expected), evalCase('una-001', [])];
    const observations = [observation('ans-001', 1, ['c1']), observation('una-001', 1, ['c1'])];

    const { recall } = await computeRecallForPass(1, observations, cases, corpusChunkById);

    expect(recall.caseCount).toBe(1);
  });

  it('should only score observations for the requested pass', async () => {
    const corpusChunkById = new Map([
      ['c1', pdfChunk('f.pdf', 3)],
      ['c2', pdfChunk('f.pdf', 1)],
    ]);
    const cases = [evalCase('ans-001', expected)];
    const observations = [observation('ans-001', 1, ['c1']), observation('ans-001', 2, ['c2'])];

    const passOne = await computeRecallForPass(1, observations, cases, corpusChunkById);
    const passTwo = await computeRecallForPass(2, observations, cases, corpusChunkById);

    expect(passOne.recall.recallAt5).toBe(1);
    expect(passTwo.recall.recallAt5).toBe(0);
  });

  it('should throw when an observation references a case not in the current dataset', async () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);
    const observations = [observation('gone-001', 1, ['c1'])];

    await expect(computeRecallForPass(1, observations, [], corpusChunkById)).rejects.toThrow(
      /'gone-001'.*not in the current dataset/,
    );
  });
});

describe('isWithinSpread', () => {
  const spread = { min: 0.6, max: 0.9, mean: 0.75 };

  it('should treat the min and max bounds as inside the band', () => {
    expect(isWithinSpread(0.6, spread)).toBe(true);
    expect(isWithinSpread(0.9, spread)).toBe(true);
  });

  it('should treat a value strictly between the bounds as inside the band', () => {
    expect(isWithinSpread(0.8, spread)).toBe(true);
  });

  it('should treat a value outside either bound as outside the band', () => {
    expect(isWithinSpread(0.5, spread)).toBe(false);
    expect(isWithinSpread(0.95, spread)).toBe(false);
  });
});

describe('findUnmatchedLocators', () => {
  it('should not flag a locator hit in only one of several passes', async () => {
    const locator = pdfLocator('f.pdf', 3);
    const corpusChunkById = new Map([
      ['hit', pdfChunk('f.pdf', 3)],
      ['miss', pdfChunk('f.pdf', 1)],
    ]);
    const cases = [evalCase('ans-001', [locator])];
    const observations = [observation('ans-001', 1, ['miss']), observation('ans-001', 2, ['hit'])];

    const unmatched = await findUnmatchedLocators(observations, cases, corpusChunkById);

    expect(unmatched).toEqual([]);
  });

  it('should flag a locator that no retrieved chunk in any pass overlaps', async () => {
    const locator = pdfLocator('f.pdf', 3);
    const corpusChunkById = new Map([
      ['c1', pdfChunk('f.pdf', 1)],
      ['c2', pdfChunk('f.pdf', 2)],
    ]);
    const cases = [evalCase('ans-001', [locator])];
    const observations = [observation('ans-001', 1, ['c1']), observation('ans-001', 2, ['c2'])];

    const unmatched = await findUnmatchedLocators(observations, cases, corpusChunkById);

    expect(unmatched).toEqual([{ caseId: 'ans-001', locator }]);
  });

  it('should contribute nothing for a case with no expected locators', async () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);
    const cases = [evalCase('una-001', [])];
    const observations = [observation('una-001', 1, ['c1'])];

    const unmatched = await findUnmatchedLocators(observations, cases, corpusChunkById);

    expect(unmatched).toEqual([]);
  });
});

describe('recallFromVariance', () => {
  it('should compute the cross-pass spread, ground-truth counts, and unmatched locators together', async () => {
    const hitLocator = pdfLocator('f.pdf', 3);
    const missLocator = pdfLocator('f.pdf', 9);
    const corpusChunkById = new Map([
      ['hit', pdfChunk('f.pdf', 3)],
      ['other', pdfChunk('f.pdf', 1)],
    ]);
    const cases = [evalCase('ans-001', [hitLocator, missLocator]), evalCase('una-001', [])];
    const observations = [
      observation('ans-001', 1, ['hit']),
      observation('una-001', 1, ['other']),
      observation('ans-001', 2, ['other']),
      observation('una-001', 2, ['other']),
    ];

    const result = await recallFromVariance(observations, cases, corpusChunkById);

    expect(result.byPass).toEqual([
      { runIndex: 1, recall: { recallAt5: 1, recallAt10: 1, mrr: 1, caseCount: 1 } },
      { runIndex: 2, recall: { recallAt5: 0, recallAt10: 0, mrr: 0, caseCount: 1 } },
    ]);
    expect(result.recallAt5Spread).toEqual({ min: 0, max: 1, mean: 0.5 });
    expect(result.recallAt10Spread).toEqual({ min: 0, max: 1, mean: 0.5 });
    expect(result.locatorBearingCaseCount).toBe(1);
    expect(result.totalExpectedLocatorCount).toBe(2);
    expect(result.unmatchedLocators).toEqual([{ caseId: 'ans-001', locator: missLocator }]);
  });

  it('should throw before computing anything when a retrieved chunk id is absent from the corpus', async () => {
    const corpusChunkById = new Map([['c1', pdfChunk('f.pdf', 1)]]);
    const cases = [evalCase('ans-001', [pdfLocator('f.pdf', 1)])];
    const observations = [observation('ans-001', 1, ['c1', 'ghost'])];

    await expect(recallFromVariance(observations, cases, corpusChunkById)).rejects.toThrow(/ghost/);
  });
});

describe('assertCorpusFingerprintMatches', () => {
  it('should not throw when the result and live fingerprints match', () => {
    expect(() => assertCorpusFingerprintMatches('fp-abc', 'fp-abc')).not.toThrow();
  });

  it('should throw naming both fingerprints on a mismatch', () => {
    expect(() => assertCorpusFingerprintMatches('fp-result', 'fp-live')).toThrow(
      /'fp-result'.*'fp-live'/s,
    );
  });
});

describe('buildCorpusChunkById', () => {
  function corpusChunkRow(id: string, documentVersionId: string): CorpusChunkRow {
    return {
      _id: id,
      text: `text ${id}`,
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
      documentVersionId,
    };
  }

  it("should resolve each row's documentVersionId to a filename and carry no elements field", () => {
    const corpusChunkById = buildCorpusChunkById(
      [corpusChunkRow('c1', 'dv1')],
      new Map([['dv1', 'f.pdf']]),
    );

    expect(corpusChunkById.get('c1')).toEqual({
      filename: 'f.pdf',
      text: 'text c1',
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'v1' },
    });
  });

  it('should throw naming the chunk id and documentVersionId when the filename does not resolve', () => {
    expect(() => buildCorpusChunkById([corpusChunkRow('c1', 'dv-missing')], new Map())).toThrow(
      /'c1'.*'dv-missing'/s,
    );
  });
});

describe('text-containment scoring (chunk carries no retained elements)', () => {
  // Regression: `buildCorpusChunkById` never sets `elements` (the shape `eval/run.ts`'s own
  // `retrievedOverlaps` candidates carry) — this pins that `chunkOverlapsLocator` still scores a
  // real hit through its text-containment path, the path the eval gate's own recall figure is
  // scored by, end to end through `computeRecallForPass`.
  it("should score a hit via chunkOverlapsLocator's text-containment path", async () => {
    const locator: Locator = {
      kind: 'docx-paragraph',
      file: 'lease-summary.docx',
      paragraphIndex: 3,
      headingPath: ['Lease Abstract — Northgate Business Park', 'Premises'],
    };
    const text = await resolveLocatorText(locator);

    const corpusChunkById = buildCorpusChunkById(
      [
        {
          _id: 'c1',
          text,
          locator: {
            kind: 'docx-paragraph',
            paragraphIndex: 0,
            headingPath: [],
            extractorVersion: 'v1',
          },
          documentVersionId: 'dv1',
        },
      ],
      new Map([['dv1', 'lease-summary.docx']]),
    );
    const cases = [evalCase('ans-001', [locator])];
    const observations = [observation('ans-001', 1, ['c1'])];

    const { recall } = await computeRecallForPass(1, observations, cases, corpusChunkById);

    expect(recall.recallAt5).toBe(1);
  });
});
