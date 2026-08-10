import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingEmbeddingProvider } from '../../../eval/providers/caching-embedding.provider';
import { EmbeddingReplayCacheMissError } from '../../../eval/providers/errors/embedding-replay-cache-miss.error';
import { FakeEmbeddingProvider } from '../../../src/providers/embedding/fake-embedding.provider';
import type { EmbeddingRequest } from '../../../src/providers/embedding/embedding-provider.interface';

describe('CachingEmbeddingProvider', () => {
  let cacheDir: string;
  let inner: FakeEmbeddingProvider;

  const request: EmbeddingRequest = {
    inputs: ['What is the cap rate for Northgate Business Park?'],
    inputType: 'query',
  };

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'evidence-ops-embedding-cache-'));
    inner = new FakeEmbeddingProvider();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('should pass through to the inner provider without touching the cache in "off" mode', async () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'off', cacheDir });

    await provider.embed(request);

    expect(inner.calls).toHaveLength(1);
  });

  it('should call through and persist a fixture on a record-mode miss', async () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'record', cacheDir });

    const result = await provider.embed(request);

    expect(result.embeddings).toHaveLength(1);
    expect(inner.calls).toHaveLength(1);
  });

  it('should reuse a recorded fixture on a second identical request instead of calling through again', async () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'record', cacheDir });

    await provider.embed(request);
    await provider.embed(request);

    expect(inner.calls).toHaveLength(1);
  });

  it('should replay a fixture recorded by an earlier instance without calling through', async () => {
    const recorder = new CachingEmbeddingProvider(inner, { mode: 'record', cacheDir });
    const recorded = await recorder.embed(request);

    const replayInner = new FakeEmbeddingProvider();
    const replayer = new CachingEmbeddingProvider(replayInner, { mode: 'replay', cacheDir });

    const result = await replayer.embed(request);

    expect(result).toEqual(recorded);
    expect(replayInner.calls).toHaveLength(0);
  });

  it('should throw loudly on a replay-mode cache miss rather than falling back to a live call', async () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'replay', cacheDir });

    await expect(provider.embed(request)).rejects.toBeInstanceOf(EmbeddingReplayCacheMissError);
    expect(inner.calls).toHaveLength(0);
  });

  it('should key query and document input types separately even for the same text', async () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'record', cacheDir });

    await provider.embed({ inputs: ['same text'], inputType: 'query' });
    await provider.embed({ inputs: ['same text'], inputType: 'document' });

    expect(inner.calls).toHaveLength(2);
  });

  it("should expose the inner provider's info unchanged", () => {
    const provider = new CachingEmbeddingProvider(inner, { mode: 'off', cacheDir });

    expect(provider.info).toEqual(inner.info);
  });
});
