import type { VarianceCaseRun } from '../../../eval/variance/variance-report';
import {
  assertResumable,
  baseSha,
  completeObservations,
  completedPassCount,
  nextObservationSlots,
  type VarianceProgress,
} from '../../../eval/variance/variance-resume';

function caseRun(caseId: string, runIndex: number): VarianceCaseRun {
  return {
    runIndex,
    caseId,
    question: 'What is the ARR?',
    outcomeKind: 'answered',
    citedChunkIds: ['aaaaaaaa1111'],
    claimCount: 1,
    retrievedChunkIds: ['aaaaaaaa1111'],
    citations: [{ chunkId: 'aaaaaaaa1111', quote: 'quoted' }],
  };
}

describe('baseSha', () => {
  it('should strip a trailing -dirty suffix', () => {
    expect(baseSha('abc123-dirty')).toBe('abc123');
  });

  it('should leave a clean sha unchanged', () => {
    expect(baseSha('abc123')).toBe('abc123');
  });

  it('should leave -dirty untouched when it is not the trailing suffix', () => {
    expect(baseSha('abc-dirty-suffix')).toBe('abc-dirty-suffix');
  });
});

describe('completeObservations and completedPassCount', () => {
  const caseIds = ['c1', 'c2'];

  it('should count a pass complete once every case in it is observed', () => {
    const observations = [caseRun('c1', 1), caseRun('c2', 1)];

    expect(completedPassCount(observations, caseIds)).toBe(1);
    expect(completeObservations(observations, caseIds)).toEqual(observations);
  });

  it('should exclude a partial pass from completeObservations and not count it', () => {
    const observations = [caseRun('c1', 1), caseRun('c2', 1), caseRun('c1', 2)];

    expect(completedPassCount(observations, caseIds)).toBe(1);
    expect(completeObservations(observations, caseIds)).toEqual([
      caseRun('c1', 1),
      caseRun('c2', 1),
    ]);
  });

  it('should count every complete pass, not only the earliest', () => {
    const observations = [caseRun('c1', 1), caseRun('c2', 1), caseRun('c1', 2), caseRun('c2', 2)];

    expect(completedPassCount(observations, caseIds)).toBe(2);
  });

  it('should report zero complete passes with no observations', () => {
    expect(completedPassCount([], caseIds)).toBe(0);
    expect(completeObservations([], caseIds)).toEqual([]);
  });
});

describe('nextObservationSlots', () => {
  const caseIds = ['c1', 'c2'];

  it('should resume at the first missing slot in pass-then-case order', () => {
    const observations = [caseRun('c1', 1), caseRun('c2', 1), caseRun('c1', 2)];

    expect(nextObservationSlots(observations, caseIds, 3)).toEqual([
      { runIndex: 2, caseId: 'c2' },
      { runIndex: 3, caseId: 'c1' },
      { runIndex: 3, caseId: 'c2' },
    ]);
  });

  it('should return every slot when nothing has been observed', () => {
    expect(nextObservationSlots([], caseIds, 2)).toEqual([
      { runIndex: 1, caseId: 'c1' },
      { runIndex: 1, caseId: 'c2' },
      { runIndex: 2, caseId: 'c1' },
      { runIndex: 2, caseId: 'c2' },
    ]);
  });

  it('should return no slots once every pass is fully observed', () => {
    const observations = [caseRun('c1', 1), caseRun('c2', 1)];

    expect(nextObservationSlots(observations, caseIds, 1)).toEqual([]);
  });
});

describe('assertResumable', () => {
  const existing: VarianceProgress = {
    baseGitSha: 'abc123',
    datasetFingerprint: 'dataset-a',
    corpusFingerprint: 'corpus-a',
    requestedRunCount: 5,
    passLabels: [],
    observations: [],
  };

  it('should not throw when dataset, corpus and run count all match', () => {
    expect(() =>
      assertResumable(existing, {
        datasetFingerprint: 'dataset-a',
        corpusFingerprint: 'corpus-a',
        requestedRunCount: 5,
      }),
    ).not.toThrow();
  });

  it('should throw naming datasetFingerprint on a dataset mismatch', () => {
    expect(() =>
      assertResumable(existing, {
        datasetFingerprint: 'dataset-b',
        corpusFingerprint: 'corpus-a',
        requestedRunCount: 5,
      }),
    ).toThrow(/datasetFingerprint/);
  });

  it('should throw naming corpusFingerprint on a corpus mismatch', () => {
    expect(() =>
      assertResumable(existing, {
        datasetFingerprint: 'dataset-a',
        corpusFingerprint: 'corpus-b',
        requestedRunCount: 5,
      }),
    ).toThrow(/corpusFingerprint/);
  });

  it('should throw naming requestedRunCount on a run-count mismatch', () => {
    expect(() =>
      assertResumable(existing, {
        datasetFingerprint: 'dataset-a',
        corpusFingerprint: 'corpus-a',
        requestedRunCount: 3,
      }),
    ).toThrow(/requestedRunCount/);
  });
});
