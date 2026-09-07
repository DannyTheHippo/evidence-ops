import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EmbeddingProviderInfo,
  EmbeddingRequest,
} from '../../../src/providers/embedding/embedding-provider.interface';
import { EmbeddingRequestMissingTenantError } from '../../../src/providers/embedding/errors/embedding-request-missing-tenant.error';
import {
  estimateEmbeddingTokens,
  SpendGuardEmbeddingProvider,
} from '../../../src/providers/embedding/spend-guard-embedding.provider';
import { computeVoyageCostUsd } from '../../../src/providers/embedding/voyage-pricing.table';
import { TenantSpendLimitExceededError } from '../../../src/providers/model/errors/tenant-spend-limit-exceeded.error';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import type { AlsContext } from '../../../src/shared/types/als-context.type';
import type { TenantSpendService } from '../../../src/providers/model/spend/tenant-spend.service';

describe('SpendGuardEmbeddingProvider', () => {
  let inner: { info: EmbeddingProviderInfo; embed: jest.Mock };
  let spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>>;
  let als: { getStore: jest.Mock };

  const request: EmbeddingRequest = { inputs: ['hello world'], inputType: 'document' };

  // The `windowStart` `reserve` returns and `settle`/`release` must receive back unchanged —
  // proves the provider threads it rather than letting the service recompute it.
  const windowStart = new Date('2026-08-17T00:00:00.000Z');

  beforeEach(() => {
    inner = {
      info: { provider: 'voyage', model: 'voyage-4', dimensions: 1024 },
      embed: jest.fn(),
    };
    spendService = {
      reserve: jest.fn().mockResolvedValue(windowStart),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    als = { getStore: jest.fn().mockReturnValue({ tenant: 'tenant-a' }) };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  const buildProvider = (dailyLimitUsd: number, ingestDailyLimitUsd?: number) =>
    new SpendGuardEmbeddingProvider(
      inner,
      spendService as unknown as TenantSpendService,
      dailyLimitUsd,
      als as unknown as AsyncLocalStorage<AlsContext>,
      ingestDailyLimitUsd,
    );

  it('should proxy info to the delegate', () => {
    const provider = buildProvider(50);

    expect(provider.info).toBe(inner.info);
  });

  it('should pass through to the delegate without touching the ledger when the ceiling is disabled', async () => {
    const provider = buildProvider(0);
    inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 3 } });

    const result = await provider.embed(request);

    expect(result.usage.totalTokens).toBe(3);
    expect(als.getStore).not.toHaveBeenCalled();
    expect(spendService.reserve).not.toHaveBeenCalled();
    expect(spendService.settle).not.toHaveBeenCalled();
    expect(spendService.release).not.toHaveBeenCalled();
  });

  it('should refuse a request with no tenant in ALS scope when the ceiling is enabled, never calling the delegate', async () => {
    als.getStore.mockReturnValue(undefined);
    const provider = buildProvider(50);

    await expect(provider.embed(request)).rejects.toBeInstanceOf(
      EmbeddingRequestMissingTenantError,
    );
    expect(inner.embed).not.toHaveBeenCalled();
    expect(spendService.reserve).not.toHaveBeenCalled();
  });

  it('should reserve an estimated cost once, then settle with the actual cost on a successful delegate call', async () => {
    const provider = buildProvider(50);
    inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 1_000_000 } });

    const result = await provider.embed(request);

    expect(result.usage.totalTokens).toBe(1_000_000);
    const estimatedCostUsd = computeVoyageCostUsd(
      'voyage-4',
      estimateEmbeddingTokens(request.inputs),
    );
    expect(spendService.reserve).toHaveBeenCalledTimes(1);
    expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', estimatedCostUsd, 50);
    expect(spendService.settle).toHaveBeenCalledWith(
      'tenant-a',
      windowStart,
      estimatedCostUsd,
      computeVoyageCostUsd('voyage-4', 1_000_000),
    );
    expect(spendService.release).not.toHaveBeenCalled();
  });

  it('should release the reservation and rethrow the original error when the delegate throws', async () => {
    const provider = buildProvider(50);
    inner.embed.mockRejectedValue(new Error('upstream refused'));

    await expect(provider.embed(request)).rejects.toThrow('upstream refused');

    const estimatedCostUsd = computeVoyageCostUsd(
      'voyage-4',
      estimateEmbeddingTokens(request.inputs),
    );
    expect(spendService.release).toHaveBeenCalledWith('tenant-a', windowStart, estimatedCostUsd);
    expect(spendService.settle).not.toHaveBeenCalled();
  });

  // The assertion that proves a refusal cannot permanently consume budget: `reserve` itself
  // throwing means no reservation exists, so nothing here should call `release`.
  it('should never call the delegate or release when the reservation itself is refused by the ceiling', async () => {
    const provider = buildProvider(50);
    spendService.reserve.mockRejectedValueOnce(
      new TenantSpendLimitExceededError('tenant-a', 1, 50, windowStart),
    );

    await expect(provider.embed(request)).rejects.toBeInstanceOf(TenantSpendLimitExceededError);
    expect(inner.embed).not.toHaveBeenCalled();
    expect(spendService.release).not.toHaveBeenCalled();
    expect(spendService.settle).not.toHaveBeenCalled();
  });

  it('should throw UnknownModelPricingError before reserving when the delegate model has no pricing entry', async () => {
    inner.info = { provider: 'voyage', model: 'voyage-nonexistent', dimensions: 1024 };
    const provider = buildProvider(50);

    await expect(provider.embed(request)).rejects.toBeInstanceOf(UnknownModelPricingError);
    expect(spendService.reserve).not.toHaveBeenCalled();
    expect(inner.embed).not.toHaveBeenCalled();
  });

  it('should reserve and settle zero cost for an empty input list', async () => {
    const provider = buildProvider(50);
    inner.embed.mockResolvedValue({ embeddings: [], usage: { totalTokens: 0 } });

    await provider.embed({ inputs: [], inputType: 'document' });

    expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', 0, 50);
    expect(spendService.settle).toHaveBeenCalledWith('tenant-a', windowStart, 0, 0);
  });

  it('should reserve a document embed against the ingest sub-ceiling when one is configured', async () => {
    const provider = buildProvider(50, 40);
    inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 3 } });

    await provider.embed({ inputs: ['hello world'], inputType: 'document' });

    const estimatedCostUsd = computeVoyageCostUsd(
      'voyage-4',
      estimateEmbeddingTokens(['hello world']),
    );
    expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', estimatedCostUsd, 40);
  });

  it('should reserve a query embed against the full ceiling even when an ingest sub-ceiling is configured', async () => {
    const provider = buildProvider(50, 40);
    inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 3 } });

    await provider.embed({ inputs: ['hello world'], inputType: 'query' });

    const estimatedCostUsd = computeVoyageCostUsd(
      'voyage-4',
      estimateEmbeddingTokens(['hello world']),
    );
    expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', estimatedCostUsd, 50);
  });

  describe('computeCostUsd parameter', () => {
    it('should use a supplied computeCostUsd for both the reservation and the settlement', async () => {
      const computeCostUsd = jest.fn((_model: string, totalTokens: number) => totalTokens * 0.001);
      const provider = new SpendGuardEmbeddingProvider(
        inner,
        spendService as unknown as TenantSpendService,
        50,
        als as unknown as AsyncLocalStorage<AlsContext>,
        undefined,
        computeCostUsd,
      );
      inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 1_000 } });

      await provider.embed(request);

      const estimatedTokens = estimateEmbeddingTokens(request.inputs);
      expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', estimatedTokens * 0.001, 50);
      expect(spendService.settle).toHaveBeenCalledWith(
        'tenant-a',
        windowStart,
        estimatedTokens * 0.001,
        1,
      );
      expect(computeCostUsd).toHaveBeenCalledWith('voyage-4', estimatedTokens);
      expect(computeCostUsd).toHaveBeenCalledWith('voyage-4', 1_000);
    });

    it('should price with Voyage pricing when computeCostUsd is omitted, as before this parameter existed', async () => {
      const provider = buildProvider(50);
      inner.embed.mockResolvedValue({ embeddings: [[0, 0]], usage: { totalTokens: 1_000_000 } });

      await provider.embed(request);

      const estimatedCostUsd = computeVoyageCostUsd(
        'voyage-4',
        estimateEmbeddingTokens(request.inputs),
      );
      expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', estimatedCostUsd, 50);
      expect(spendService.settle).toHaveBeenCalledWith(
        'tenant-a',
        windowStart,
        estimatedCostUsd,
        computeVoyageCostUsd('voyage-4', 1_000_000),
      );
    });
  });
});
