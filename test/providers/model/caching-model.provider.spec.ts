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

  // Regression for the read-through defect this change fixes: without `passOrdinal` folded into
  // the cache key, three identical-prompt extraction passes would all hash to the same key, and
  // record mode's read-through (line 72 in the provider) would serve pass 1's cached response to
  // passes 2 and 3 — making multi-pass agreement vacuous against these fixtures.
  it('should call through separately for identical requests differing only in passOrdinal, never reusing one pass for another', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'record', cacheDir });
    inner.enqueueResult({ output: 'Paris' });
    inner.enqueueResult({ output: 'London' });

    const first = await provider.generate({ ...request, passOrdinal: 0 });
    const second = await provider.generate({ ...request, passOrdinal: 1 });

    expect(first.output).toBe('Paris');
    expect(second.output).toBe('London');
    expect(inner.calls).toHaveLength(2);
  });

  // `tenantId` is a policy field for spend attribution (`SpendGuardModelProvider`), not part of
  // the request's identity — two tenants asking the identical prompt must still share one
  // cache entry, or the replay cache would fragment by tenant for no content-addressed reason.
  it('should reuse the cached fixture for identical requests differing only in tenantId', async () => {
    const provider = new CachingModelProvider(inner, { mode: 'record', cacheDir });
    inner.enqueueResult({ output: 'Paris' });

    const first = await provider.generate({ ...request, tenantId: 'tenant-a' });
    const second = await provider.generate({ ...request, tenantId: 'tenant-b' });

    expect(first.output).toBe('Paris');
    expect(second.output).toBe('Paris');
    expect(inner.calls).toHaveLength(1);
  });
});
