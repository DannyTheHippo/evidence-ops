import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CachingModelProviderOptions } from '../../src/providers/model/caching-model.provider';
import { FakeModelProvider } from '../../src/providers/model/fake-model.provider';
import type { ModelRequest } from '../../src/providers/model/model-provider.interface';
import type { TenantSpendService } from '../../src/providers/model/spend/tenant-spend.service';
import { TracingModelProvider } from '../../src/providers/model/tracing-model.provider';
import { createModelProvider } from '../../src/providers/providers.module';
import type { Telemetry } from '../../src/providers/telemetry/telemetry.interface';
import { getMockTypedConfig } from '../utils/get-mock-typed-config';

describe('createModelProvider', () => {
  let cacheDir: string;
  let anthropic: FakeModelProvider;
  let openai: FakeModelProvider;
  let telemetry: Telemetry;

  const noLedgerSpendService = {} as TenantSpendService;

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
    telemetry = { event: jest.fn() };
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    jest.resetAllMocks();
  });

  it('routes to the anthropic base by default', async () => {
    // dailyLimitUsd: 0 disables SpendGuard's ledger so this test can stay focused on routing.
    const config = getMockTypedConfig({ spend: { dailyLimitUsd: 0 } });
    anthropic.enqueueResult({ output: 'anthropic-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
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
      spend: { dailyLimitUsd: 0 },
    });
    openai.enqueueResult({ output: 'openai-answer' });

    const provider = createModelProvider(
      anthropic,
      openai,
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

  it('wraps the base in TracingModelProvider without changing the outer decorator', () => {
    const config = getMockTypedConfig({ spend: { dailyLimitUsd: 0 } });

    const provider = createModelProvider(
      anthropic,
      openai,
      noLedgerSpendService,
      cacheOptions(),
      telemetry,
      config,
    );

    expect(provider).toBeInstanceOf(TracingModelProvider);
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
});
