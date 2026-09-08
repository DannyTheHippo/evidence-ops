import { sampleDocuments } from '../../../../scripts/experiments/verifier/sample-documents';
import { makeDocument } from './verifier-fixtures';

function makeDocuments(count: number) {
  return Array.from({ length: count }, (_unused, index) =>
    makeDocument({ filename: `doc-${String(index + 1).padStart(2, '0')}.pdf` }),
  );
}

describe('sampleDocuments', () => {
  it('returns every document, in corpus order, when count is at or above the population size', () => {
    const documents = makeDocuments(3);

    const sample = sampleDocuments(documents, 3, 7);

    expect(sample.documents).toEqual(documents);
    expect(sample.filenames).toEqual(documents.map((document) => document.filename));
    expect(sample.populationSize).toBe(3);
    expect(sampleDocuments(documents, 5, 7).documents).toEqual(documents);
  });

  it('draws exactly count documents above the population size, and records the population it drew from', () => {
    const documents = makeDocuments(10);

    const sample = sampleDocuments(documents, 4, 7);

    expect(sample.documents).toHaveLength(4);
    expect(new Set(sample.filenames).size).toBe(4);
    expect(sample.populationSize).toBe(10);
    for (const filename of sample.filenames) {
      expect(documents.some((document) => document.filename === filename)).toBe(true);
    }
  });

  it('reproduces the same draw for the same seed and differs for another', () => {
    const documents = makeDocuments(10);

    expect(sampleDocuments(documents, 4, 7).filenames).toEqual(
      sampleDocuments(documents, 4, 7).filenames,
    );
    expect(sampleDocuments(documents, 4, 8).filenames).not.toEqual(
      sampleDocuments(documents, 4, 7).filenames,
    );
  });

  it('returns the drawn documents in the corpus own order', () => {
    const documents = makeDocuments(10);

    const { documents: drawn } = sampleDocuments(documents, 4, 7);
    const positions = drawn.map((document) => documents.indexOf(document));

    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('handles an empty corpus', () => {
    expect(sampleDocuments([], 4, 7)).toEqual({
      seed: 7,
      populationSize: 0,
      filenames: [],
      documents: [],
    });
  });
});
