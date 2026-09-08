import type { CorpusChunk, CorpusDocument } from './types';

export interface WindowedDocument {
  readonly document: CorpusDocument;
  readonly windowed: boolean;
  /** Tokens actually carried into the drafting prompt — equal to `documentTokenCount` when
   *  `windowed` is `false`. */
  readonly tokenCount: number;
  readonly documentTokenCount: number;
}

/**
 * Trims a document to its leading chunks whose cumulative `tokenCount` fits `budgetTokens`, so a
 * document too large for the drafting prompt whole still gets drafted from rather than skipped —
 * skipping would measure the gate on files small enough to fit, not on filings, which is the case
 * this budget exists for. Refuses outright when even the first chunk alone cannot fit: there is no
 * partial-chunk window to draft from.
 */
export function windowDocumentToBudget(
  document: CorpusDocument,
  budgetTokens: number,
): WindowedDocument {
  const documentTokenCount = document.chunks.reduce((total, chunk) => total + chunk.tokenCount, 0);
  if (documentTokenCount <= budgetTokens) {
    return { document, windowed: false, tokenCount: documentTokenCount, documentTokenCount };
  }

  const firstChunk = document.chunks[0];
  if (firstChunk === undefined || firstChunk.tokenCount > budgetTokens) {
    throw new Error(
      `windowDocumentToBudget: '${document.filename}' cannot be windowed under the ` +
        `${budgetTokens}-token budget — its first chunk alone is ` +
        `${firstChunk?.tokenCount ?? 0} tokens`,
    );
  }

  const windowedChunks: CorpusChunk[] = [];
  let tokenCount = 0;
  for (const chunk of document.chunks) {
    if (tokenCount + chunk.tokenCount > budgetTokens) {
      break;
    }
    windowedChunks.push(chunk);
    tokenCount += chunk.tokenCount;
  }

  return {
    document: { ...document, chunks: windowedChunks },
    windowed: true,
    tokenCount,
    documentTokenCount,
  };
}
