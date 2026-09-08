import { createSeededRandom } from './sample-for-adjudication';
import type { CorpusDocument } from './types';

/** Which documents were drawn to bound a run's cost, and how. The filenames — not the seed — are
 *  the authoritative record: they stay valid if the generator ever changes. */
export interface DocumentSample {
  readonly seed: number;
  readonly populationSize: number;
  readonly filenames: readonly string[];
  readonly documents: readonly CorpusDocument[];
}

/**
 * Draws the documents a run drafts from: every document at or below `count`, otherwise a seeded
 * uniform draw without replacement, returned in the corpus's own order so a windowed drafting pass
 * still reads the corpus front to back.
 */
export function sampleDocuments(
  documents: readonly CorpusDocument[],
  count: number,
  seed: number,
): DocumentSample {
  if (count >= documents.length) {
    return {
      seed,
      populationSize: documents.length,
      filenames: documents.map((document) => document.filename),
      documents,
    };
  }

  const indices = documents.map((_, index) => index);
  const random = createSeededRandom(seed);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [indices[index], indices[swapWith]] = [indices[swapWith], indices[index]];
  }

  const drawn = indices
    .slice(0, count)
    .sort((left, right) => left - right)
    .map((index) => documents[index]);

  return {
    seed,
    populationSize: documents.length,
    filenames: drawn.map((document) => document.filename),
    documents: drawn,
  };
}
