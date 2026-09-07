import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EmbeddingProviderInfo,
  EmbeddingRequest,
} from '../../src/providers/embedding/embedding-provider.interface';
import { SpendGuardEmbeddingProvider } from '../../src/providers/embedding/spend-guard-embedding.provider';
import { CachingModelProvider } from '../../src/providers/model/caching-model.provider';
import type { CachingModelProviderOptions } from '../../src/providers/model/caching-model.provider';
import { FakeModelProvider } from '../../src/providers/model/fake-model.provider';
import type { ModelRequest } from '../../src/providers/model/model-provider.interface';
import type { TenantSpendService } from '../../src/providers/model/spend/tenant-spend.service';
import { createEmbeddingProvider, createModelProvider } from '../../src/providers/providers.module';
import { modelCostHistogram } from '../../src/providers/telemetry/domain-metrics';
import type { Telemetry } from '../../src/providers/telemetry/telemetry.interface';
import type { AlsContext } from '../../src/shared/types/als-context.type';
import { getMockTypedConfig } from '../utils/get-mock-typed-config';

describe('createModelProvider', () => {
  let cacheDir: string;
  let anthropic: FakeModelProvider;
  let openai: FakeModelProvider;
  let openaiCompatible: FakeModelProvider;
  let telemetry: Telemetry;
  // Held separately, and asserted on directly, rather than through `telemetry.event` — `Telemetry`
  // declares `event` with method syntax, so referencing it off `telemetry` trips
  // `@typescript-eslint/unbound-method` (the access could lose its `this` binding).
  let telemetryEvent: jest.Mock;

  const noLedgerSpendService = {} as TenantSpendService;

  // `getMockTypedConfig` passes each namespace straight through, so a partial override would drop
  // the rest of the namespace rather than merging into it.
  const compatibleConfig = {
    apiKey: 'compatible-key',
    baseUrl: 'https://compatible.example/v1',
    model: 'mixtral-8x7b',
    embeddingModel: 'compatible-embed',
    timeoutMs: 30_000,
    structuredOutput: 'json_schema' as const,
    priceInputUsdPerMtok: 0.5,
    priceOutputUsdPerMtok: 1.5,
    embeddingPriceUsdPerMtok: 0.02,
  };

  const request: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 128,
    maxCostUsd: 1,
  };

  const cacheOptions = (mode: CachingModelProviderOptions['mode'] = 'off') => ({
    mode,
    cacheDir,
  });

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'evidence-ops-model-provider-'));
    anthropic = new FakeModelProvider();
    openai = new FakeModelProvider();
    openaiCompatible = new FakeModelProvider();
    telemetryEvent = jest.fn();
    telemetry = { event: telemetryEvent };
    // `modelCostHistogram` is a module-scope singleton (not a fresh instance per test like
    // `telemetry`/`anthropic`/`openai` above), so a `jest.spyOn` in an individual test would
    // otherwise return the same mock — and its accumulated call history — across every test here.
    jest.spyOn(modelCostHistogram, 'record').mockClear();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    jest.resetAllMocks();
  });

  it('routes to the anthropic base by default', async () => {
    // dailyLimitUsd: 0 disables SpendGuard's ledger so this test can stay focused on routing.
    const config = getMockTypedConfig({
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
    });
    anthropic.enqueueResult({ output: 'anthropic-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      noLedgerSpendService,
      cacheOptions(),
      telemetry,
      config,
    );
    const result = await provider.generate(request);

    expect(result.output).toBe('anthropic-answer');
    expect(anthropic.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(0);
  });

  it('routes to the openai base when MODEL_PROVIDER=openai', async () => {
    const config = getMockTypedConfig({
      model: { provider: 'openai' },
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
    });
    openai.enqueueResult({ output: 'openai-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      noLedgerSpendService,
      cacheOptions(),
      telemetry,
      config,
    );
    const result = await provider.generate(request);

    expect(result.output).toBe('openai-answer');
    expect(openai.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('routes to the openai-compatible base when MODEL_PROVIDER=openai-compatible', async () => {
    const config = getMockTypedConfig({
      model: { provider: 'openai-compatible' },
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
      openaiCompatible: compatibleConfig,
    });
    openaiCompatible.enqueueResult({ output: 'compatible-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      noLedgerSpendService,
      cacheOptions(),
      telemetry,
      config,
    );
    const result = await provider.generate(request);

    expect(result.output).toBe('compatible-answer');
    expect(openaiCompatible.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  // The refusal lives here, on the branch that selects the compatible base, rather than in
  // `OpenAiCompatibleModelProvider`'s constructor: Nest builds that class on every boot regardless
  // of `MODEL_PROVIDER`, so a constructor refusal breaks the default `anthropic` deployment, which
  // never calls it. The pair below pins both halves of that.
  it.each([
    ['priceInputUsdPerMtok', 'OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK'],
    ['priceOutputUsdPerMtok', 'OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK'],
  ])('refuses to wire the compatible base when %s is unset', (field, envVar) => {
    const config = getMockTypedConfig({
      model: { provider: 'openai-compatible' },
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
      openaiCompatible: { ...compatibleConfig, [field]: undefined },
    });

    expect(() =>
      createModelProvider(
        anthropic,
        openai,
        openaiCompatible,
        noLedgerSpendService,
        cacheOptions(),
        telemetry,
        config,
      ),
    ).toThrow(envVar);
  });

  it('wires the anthropic base with no compatible prices configured at all', () => {
    const config = getMockTypedConfig({
      model: { provider: 'anthropic' },
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
      openaiCompatible: {
        ...compatibleConfig,
        priceInputUsdPerMtok: undefined,
        priceOutputUsdPerMtok: undefined,
      },
    });

    expect(() =>
      createModelProvider(
        anthropic,
        openai,
        openaiCompatible,
        noLedgerSpendService,
        cacheOptions(),
        telemetry,
        config,
      ),
    ).not.toThrow();
  });

  // Still `CachingModelProvider` even after adding `Metrics` to the chain — `Metrics` sits inside
  // `Caching`, not outside it (see the next two tests for why). This only pins the outer type;
  // it does not prove `Metrics` is in the chain at all, which the two tests below do.
  it('wraps the base in CachingModelProvider as the outermost decorator', () => {
    const config = getMockTypedConfig({
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
    });

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      noLedgerSpendService,
      cacheOptions(),
      telemetry,
      config,
    );

    expect(provider).toBeInstanceOf(CachingModelProvider);
  });

  it('keeps SpendGuard inside Caching — a cached replay never reserves spend twice', async () => {
    const spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>> = {
      reserve: jest.fn().mockResolvedValue(undefined),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const config = getMockTypedConfig();
    anthropic.enqueueResult({ output: 'anthropic-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      spendService as unknown as TenantSpendService,
      cacheOptions('record'),
      telemetry,
      config,
    );
    const tenantRequest: ModelRequest<undefined> = { ...request, tenantId: 'tenant-a' };

    await provider.generate(tenantRequest);
    const second = await provider.generate(tenantRequest);

    expect(second.output).toBe('anthropic-answer');
    expect(anthropic.calls).toHaveLength(1);
    expect(spendService.reserve).toHaveBeenCalledTimes(1);
  });

  it('keeps Metrics inside Caching — a cached replay records no cost and emits no event', async () => {
    const config = getMockTypedConfig({
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
    });
    anthropic.enqueueResult({ output: 'anthropic-answer', costUsd: 0.042 });
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');

    const provider = createModelProvider(
      anthropic,
      openai,
      openaiCompatible,
      noLedgerSpendService,
      cacheOptions('record'),
      telemetry,
      config,
    );

    await provider.generate(request);
    expect(costHistogramSpy).toHaveBeenCalledTimes(1);
    expect(telemetryEvent).toHaveBeenCalledTimes(2); // start, success

    costHistogramSpy.mockClear();
    telemetryEvent.mockClear();

    const second = await provider.generate(request);

    expect(second.output).toBe('anthropic-answer');
    expect(anthropic.calls).toHaveLength(1);
    expect(costHistogramSpy).not.toHaveBeenCalled();
    expect(telemetryEvent).not.toHaveBeenCalled();
  });
});

describe('createEmbeddingProvider', () => {
  let voyage: { info: EmbeddingProviderInfo; embed: jest.Mock };
  let openaiCompatible: { info: EmbeddingProviderInfo; embed: jest.Mock };
  let als: { getStore: jest.Mock };

  const request: EmbeddingRequest = { inputs: ['hello world'], inputType: 'document' };

  beforeEach(() => {
    voyage = {
      info: { provider: 'voyage', model: 'voyage-4', dimensions: 1024 },
      embed: jest.fn().mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 3 } }),
    };
    openaiCompatible = {
      info: { provider: 'openai-compatible', model: 'mxbai-embed-large', dimensions: 1024 },
      embed: jest.fn().mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 3 } }),
    };
    als = { getStore: jest.fn().mockReturnValue({ tenant: 'tenant-a' }) };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('wraps the base in SpendGuardEmbeddingProvider, with no cache in front of it', () => {
    const config = getMockTypedConfig({
      spend: { dailyLimitUsd: 0, ingestDailyLimitUsd: undefined },
    });
    const noLedgerSpendService = {} as TenantSpendService;

    const provider = createEmbeddingProvider(
      voyage,
      openaiCompatible,
      noLedgerSpendService,
      als as unknown as AsyncLocalStorage<AlsContext>,
      config,
    );

    expect(provider).toBeInstanceOf(SpendGuardEmbeddingProvider);
  });

  // The assertion that matters most on the embedding chain: production has no caching layer, so
  // every call reaches the guard and reserves once — proves the guard is actually in the path
  // rather than bypassed.
  it('reserves once per real call to the delegate', async () => {
    const spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>> = {
      reserve: jest.fn().mockResolvedValue(new Date('2026-08-17T00:00:00.000Z')),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const config = getMockTypedConfig();

    const provider = createEmbeddingProvider(
      voyage,
      openaiCompatible,
      spendService as unknown as TenantSpendService,
      als as unknown as AsyncLocalStorage<AlsContext>,
      config,
    );

    await provider.embed(request);
    await provider.embed(request);

    expect(voyage.embed).toHaveBeenCalledTimes(2);
    expect(spendService.reserve).toHaveBeenCalledTimes(2);
  });

  it('releases the reservation when the delegate call fails, never settling it', async () => {
    const spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>> = {
      reserve: jest.fn().mockResolvedValue(new Date('2026-08-17T00:00:00.000Z')),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const config = getMockTypedConfig();
    voyage.embed.mockRejectedValue(new Error('voyage unavailable'));

    const provider = createEmbeddingProvider(
      voyage,
      openaiCompatible,
      spendService as unknown as TenantSpendService,
      als as unknown as AsyncLocalStorage<AlsContext>,
      config,
    );

    await expect(provider.embed(request)).rejects.toThrow('voyage unavailable');

    expect(spendService.release).toHaveBeenCalledTimes(1);
    expect(spendService.settle).not.toHaveBeenCalled();
  });

  it('routes to the openai-compatible base on EMBEDDING_PROVIDER=openai-compatible, pricing off the configured rate', async () => {
    const spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>> = {
      reserve: jest.fn().mockResolvedValue(new Date('2026-08-17T00:00:00.000Z')),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const config = getMockTypedConfig({
      embedding: { provider: 'openai-compatible', dimensions: 1024 },
      openaiCompatible: {
        apiKey: undefined,
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1:8b',
        embeddingModel: 'mxbai-embed-large',
        timeoutMs: 60_000,
        structuredOutput: 'json_schema',
        priceInputUsdPerMtok: undefined,
        priceOutputUsdPerMtok: undefined,
        embeddingPriceUsdPerMtok: 0.02,
      },
    });

    const provider = createEmbeddingProvider(
      voyage,
      openaiCompatible,
      spendService as unknown as TenantSpendService,
      als as unknown as AsyncLocalStorage<AlsContext>,
      config,
    );

    await provider.embed(request);

    expect(openaiCompatible.embed).toHaveBeenCalledTimes(1);
    expect(voyage.embed).not.toHaveBeenCalled();
    expect(spendService.settle).toHaveBeenCalledTimes(1);
    const actualCostUsd = spendService.settle.mock.calls[0]?.[3];
    expect(actualCostUsd).toBeCloseTo((3 * 0.02) / 1_000_000);
  });

  it('throws when EMBEDDING_PROVIDER=openai-compatible but no embedding price is configured', () => {
    const config = getMockTypedConfig({
      embedding: { provider: 'openai-compatible', dimensions: 1024 },
    });
    const noLedgerSpendService = {} as TenantSpendService;

    expect(() =>
      createEmbeddingProvider(
        voyage,
        openaiCompatible,
        noLedgerSpendService,
        als as unknown as AsyncLocalStorage<AlsContext>,
        config,
      ),
    ).toThrow('OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK');
  });
});
