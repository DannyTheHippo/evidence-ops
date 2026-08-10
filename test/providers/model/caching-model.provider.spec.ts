import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingModelProvider } from '../../../src/providers/model/caching-model.provider';
import { ModelReplayCacheMissError } from '../../../src/providers/model/errors/model-replay-cache-miss.error';
import { FakeModelProvider } from '../../../src/providers/model/fake-model.provider';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';

describe('CachingModelProvider', () => {
  let cacheDir: string;
  let inner: FakeModelProvider;

  const request: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 128,
    maxCostUsd: 1,
  };

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'evidence-ops-model-cache-'));
    inner = new FakeModelProvider();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('should pass through to the inner provider without touching the cache in "off" mode', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'off', cacheDir });
    inner.enqueueResult({ output: 'Paris' });

    const result = await provider.generate(request);

    expect(result.output).toBe('Paris');
    expect(inner.calls).toHaveLength(1);
  });

  it('should call through and persist a fixture on a record-mode miss', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'record', cacheDir });
    inner.enqueueResult({ output: 'Paris' });

    const result = await provider.generate(request);

    expect(result.output).toBe('Paris');
    expect(inner.calls).toHaveLength(1);
  });

  it('should reuse a recorded fixture on a second identical request instead of calling through again', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'record', cacheDir });
    inner.enqueueResult({ output: 'Paris' });

    await provider.generate(request);
    const second = await provider.generate(request);

    expect(second.output).toBe('Paris');
    expect(inner.calls).toHaveLength(1);
  });

  it('should replay a fixture recorded by an earlier instance without calling through', async () => {
    const recorder = new CachingModelProvider(inner, { mode: 'record', cacheDir });
    inner.enqueueResult({ output: 'Paris' });
    await recorder.generate(request);

    const replayInner = new FakeModelProvider();
    const replayer = new CachingModelProvider(replayInner, { mode: 'replay', cacheDir });

    const result = await replayer.generate(request);

    expect(result.output).toBe('Paris');
    expect(replayInner.calls).toHaveLength(0);
  });

  it('should throw loudly on a replay-mode cache miss rather than falling back to a live call', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'replay', cacheDir });

    await expect(provider.generate(request)).rejects.toBeInstanceOf(ModelReplayCacheMissError);
    expect(inner.calls).toHaveLength(0);
  });
});
