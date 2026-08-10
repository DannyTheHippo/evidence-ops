import {
  computeEmbeddingCacheKey,
  type EmbeddingCacheKeyInput,
} from '../../../eval/providers/embedding-cache-key.util';

describe('computeEmbeddingCacheKey', () => {
  const baseInput: EmbeddingCacheKeyInput = {
    provider: 'voyage',
    model: 'voyage-4',
    dimensions: 1024,
    inputType: 'query',
    inputs: ['What is the cap rate?'],
  };

  it('should be deterministic for identical input', () => {
    expect(computeEmbeddingCacheKey(baseInput)).toBe(computeEmbeddingCacheKey({ ...baseInput }));
  });

  it('should differ when the model changes', () => {
    const a = computeEmbeddingCacheKey(baseInput);
    const b = computeEmbeddingCacheKey({ ...baseInput, model: 'voyage-3' });

    expect(a).not.toBe(b);
  });

  it('should differ when dimensions change', () => {
    const a = computeEmbeddingCacheKey(baseInput);
    const b = computeEmbeddingCacheKey({ ...baseInput, dimensions: 512 });

    expect(a).not.toBe(b);
  });

  it('should differ between query and document input types for the same text', () => {
    const a = computeEmbeddingCacheKey(baseInput);
    const b = computeEmbeddingCacheKey({ ...baseInput, inputType: 'document' });

    expect(a).not.toBe(b);
  });

  it('should differ when the inputs change', () => {
    const a = computeEmbeddingCacheKey(baseInput);
    const b = computeEmbeddingCacheKey({ ...baseInput, inputs: ['A different question'] });

    expect(a).not.toBe(b);
  });

  it('should differ when input order changes', () => {
    const a = computeEmbeddingCacheKey({ ...baseInput, inputs: ['first', 'second'] });
    const b = computeEmbeddingCacheKey({ ...baseInput, inputs: ['second', 'first'] });

    expect(a).not.toBe(b);
  });
});
