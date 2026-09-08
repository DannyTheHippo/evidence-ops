import { windowDocumentToBudget } from '../../../../scripts/experiments/verifier/window-document';
import { makeChunk, makeDocument } from './verifier-fixtures';

describe('windowDocumentToBudget', () => {
  it('leaves a document under budget unwindowed', () => {
    const document = makeDocument({
      chunks: [makeChunk({ chunkId: 'chunk-1', tokenCount: 100 })],
    });

    const result = windowDocumentToBudget(document, 200);

    expect(result).toEqual({
      document,
      windowed: false,
      tokenCount: 100,
      documentTokenCount: 100,
    });
  });

  it('trims to the leading chunks whose cumulative tokens fit the budget', () => {
    const document = makeDocument({
      chunks: [
        makeChunk({ chunkId: 'chunk-1', tokenCount: 40 }),
        makeChunk({ chunkId: 'chunk-2', tokenCount: 40 }),
        makeChunk({ chunkId: 'chunk-3', tokenCount: 40 }),
      ],
    });

    const result = windowDocumentToBudget(document, 90);

    expect(result.windowed).toBe(true);
    expect(result.document.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-1', 'chunk-2']);
    expect(result.tokenCount).toBe(80);
    expect(result.documentTokenCount).toBe(120);
  });

  it('throws when the first chunk alone exceeds the budget', () => {
    const document = makeDocument({
      chunks: [makeChunk({ chunkId: 'chunk-1', tokenCount: 500 })],
    });

    expect(() => windowDocumentToBudget(document, 100)).toThrow(/first chunk alone/);
  });

  it('treats a document exactly at the budget as unwindowed', () => {
    const document = makeDocument({
      chunks: [makeChunk({ chunkId: 'chunk-1', tokenCount: 100 })],
    });

    expect(windowDocumentToBudget(document, 100).windowed).toBe(false);
  });
});
