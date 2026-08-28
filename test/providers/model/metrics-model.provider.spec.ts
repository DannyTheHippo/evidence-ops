import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingModelProvider } from '../../../src/providers/model/caching-model.provider';
import { FakeModelProvider } from '../../../src/providers/model/fake-model.provider';
import { MetricsModelProvider } from '../../../src/providers/model/metrics-model.provider';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import { modelCostHistogram } from '../../../src/providers/telemetry/domain-metrics';
import type { Telemetry } from '../../../src/providers/telemetry/telemetry.interface';

describe('MetricsModelProvider', () => {
  let telemetry: Telemetry;
  // Held separately, and asserted on directly, rather than through `telemetry.event` — `Telemetry`
  // declares `event` with method syntax, so referencing it off `telemetry` trips
  // `@typescript-eslint/unbound-method` (the access could lose its `this` binding).
  let telemetryEvent: jest.Mock;
  let inner: FakeModelProvider;
  let cacheDir: string;

  const request: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    system: 'You answer only from the supplied evidence.',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 128,
    maxCostUsd: 1,
  };

  beforeEach(async () => {
    telemetryEvent = jest.fn();
    telemetry = { event: telemetryEvent };
    inner = new FakeModelProvider();
    cacheDir = await mkdtemp(join(tmpdir(), 'evidence-ops-metrics-model-'));
    // `modelCostHistogram` is a module-scope singleton (not a fresh instance per test like
    // `telemetry`/`inner` above), so `jest.spyOn` in an individual test would otherwise return the
    // same mock — and its accumulated call history — across every test in this file.
    jest.spyOn(modelCostHistogram, 'record').mockClear();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    jest.resetAllMocks();
  });

  it('should record the call cost on the domain cost histogram, by provider and taskClass', async () => {
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');
    const provider = new MetricsModelProvider(inner, telemetry);
    inner.enqueueResult({ output: 'Paris', costUsd: 0.042 });

    await provider.generate(request);

    expect(costHistogramSpy).toHaveBeenCalledWith(0.042, {
      provider: 'fake',
      taskClass: 'qa_answer',
    });
  });

  it('should emit a start event then a success event carrying usage, cost, and duration', async () => {
    const provider = new MetricsModelProvider(inner, telemetry);
    inner.enqueueResult({ output: 'Paris', costUsd: 0.042 });

    await provider.generate(request);

    expect(telemetryEvent).toHaveBeenNthCalledWith(1, {
      name: 'model.request.start',
      attributes: { taskClass: 'qa_answer', provider: 'fake', model: 'fake-model' },
    });
    expect(telemetryEvent).toHaveBeenNthCalledWith(2, {
      name: 'model.request.success',
      attributes: expect.objectContaining({
        taskClass: 'qa_answer',
        provider: 'fake',
        model: 'fake-model',
        costUsd: 0.042,
        durationMs: expect.any(Number) as number,
      }) as Record<string, unknown>,
    });
  });

  it('should not record a cost on the domain cost histogram when the inner provider fails', async () => {
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');
    const provider = new MetricsModelProvider(inner, telemetry);
    inner.enqueueError(new Error('upstream refused'));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    expect(costHistogramSpy).not.toHaveBeenCalled();
  });

  it('should emit a start event then an error event, and rethrow the original error', async () => {
    const provider = new MetricsModelProvider(inner, telemetry);
    inner.enqueueError(new Error('upstream refused'));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    expect(telemetryEvent).toHaveBeenNthCalledWith(1, {
      name: 'model.request.start',
      attributes: { taskClass: 'qa_answer', provider: 'fake', model: 'fake-model' },
    });
    expect(telemetryEvent).toHaveBeenNthCalledWith(2, {
      name: 'model.request.error',
      attributes: expect.objectContaining({
        taskClass: 'qa_answer',
        provider: 'fake',
        model: 'fake-model',
        error: 'upstream refused',
        durationMs: expect.any(Number) as number,
      }) as Record<string, unknown>,
    });
  });

  // Placement regression: `providers.module.ts` wires `Caching(Metrics(SpendGuard(base)))` so a
  // cache hit — which never calls this decorator's inner provider — records no cost and emits no
  // event. Composed directly here, rather than relying solely on the module-spec coverage, to pin
  // the property against this class regardless of how the module wires it.
  it('should record nothing on a cache hit when composed inside CachingModelProvider', async () => {
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');
    const cached = new CachingModelProvider(new MetricsModelProvider(inner, telemetry), {
      mode: 'record',
      cacheDir,
    });
    inner.enqueueResult({ output: 'Paris', costUsd: 0.042 });

    await cached.generate(request);
    telemetryEvent.mockClear();
    costHistogramSpy.mockClear();

    const second = await cached.generate(request);

    expect(second.output).toBe('Paris');
    expect(inner.calls).toHaveLength(1);
    expect(costHistogramSpy).not.toHaveBeenCalled();
    expect(telemetryEvent).not.toHaveBeenCalled();
  });
});
