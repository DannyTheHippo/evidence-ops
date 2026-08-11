import { computeCorpusFingerprint } from '../../eval/compute-corpus-fingerprint';

describe('computeCorpusFingerprint', () => {
  it('should be identical for the same id set in two different orders', () => {
    const a = computeCorpusFingerprint(['chunk-a', 'chunk-b', 'chunk-c']);
    const b = computeCorpusFingerprint(['chunk-c', 'chunk-a', 'chunk-b']);

    expect(a).toBe(b);
  });

  it('should differ when the id set changes', () => {
    const a = computeCorpusFingerprint(['chunk-a', 'chunk-b']);
    const b = computeCorpusFingerprint(['chunk-a', 'chunk-b', 'chunk-c']);

    expect(a).not.toBe(b);
  });

  it('should be deterministic for identical input', () => {
    const ids = ['chunk-a', 'chunk-b'];

    expect(computeCorpusFingerprint(ids)).toBe(computeCorpusFingerprint([...ids]));
  });

  it('should differ for an empty corpus vs. a non-empty one', () => {
    expect(computeCorpusFingerprint([])).not.toBe(computeCorpusFingerprint(['chunk-a']));
  });
});
