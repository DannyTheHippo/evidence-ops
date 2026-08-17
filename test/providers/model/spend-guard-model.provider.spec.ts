import { ModelRequestMissingTenantError } from '../../../src/providers/model/errors/model-request-missing-tenant.error';
import { TenantSpendLimitExceededError } from '../../../src/providers/model/errors/tenant-spend-limit-exceeded.error';
import { FakeModelProvider } from '../../../src/providers/model/fake-model.provider';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import { SpendGuardModelProvider } from '../../../src/providers/model/spend-guard-model.provider';
import type { TenantSpendService } from '../../../src/providers/model/spend/tenant-spend.service';

describe('SpendGuardModelProvider', () => {
  let inner: FakeModelProvider;
  let spendService: jest.Mocked<Pick<TenantSpendService, 'reserve' | 'settle' | 'release'>>;

  const request: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 128,
    maxCostUsd: 1,
    tenantId: 'tenant-a',
  };

  // The `windowStart` `reserve` returns and `settle`/`release` must receive back unchanged —
  // proves the provider threads it rather than letting the service recompute it.
  const windowStart = new Date('2026-08-17T00:00:00.000Z');

  beforeEach(() => {
    inner = new FakeModelProvider();
    spendService = {
      reserve: jest.fn().mockResolvedValue(windowStart),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should proxy info to the delegate', () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      50,
    );

    expect(provider.info).toBe(inner.info);
  });

  it('should pass through to the delegate without touching the ledger when the ceiling is disabled', async () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      0,
    );
    inner.enqueueResult({ output: 'Paris' });

    const result = await provider.generate(request);

    expect(result.output).toBe('Paris');
    expect(spendService.reserve).not.toHaveBeenCalled();
    expect(spendService.settle).not.toHaveBeenCalled();
    expect(spendService.release).not.toHaveBeenCalled();
  });

  it('should refuse a request with no tenantId when the ceiling is enabled, never calling the delegate', async () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      50,
    );
    const untenanted: ModelRequest<undefined> = {
      taskClass: request.taskClass,
      messages: request.messages,
      maxTokens: request.maxTokens,
      maxCostUsd: request.maxCostUsd,
    };

    await expect(provider.generate(untenanted)).rejects.toBeInstanceOf(
      ModelRequestMissingTenantError,
    );
    expect(inner.calls).toHaveLength(0);
    expect(spendService.reserve).not.toHaveBeenCalled();
  });

  it('should reserve then settle with the actual cost on a successful delegate call', async () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      50,
    );
    inner.enqueueResult({ output: 'Paris', costUsd: 0.42 });

    const result = await provider.generate(request);

    expect(result.output).toBe('Paris');
    expect(spendService.reserve).toHaveBeenCalledWith('tenant-a', 1, 50);
    expect(spendService.settle).toHaveBeenCalledWith('tenant-a', windowStart, 1, 0.42);
    expect(spendService.release).not.toHaveBeenCalled();
  });

  it('should release the reservation and rethrow the original error when the delegate throws', async () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      50,
    );
    inner.enqueueError(new Error('upstream refused'));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    expect(spendService.release).toHaveBeenCalledWith('tenant-a', windowStart, 1);
    expect(spendService.settle).not.toHaveBeenCalled();
  });

  it('should never call the delegate when the reservation itself is refused', async () => {
    const provider = new SpendGuardModelProvider(
      inner,
      spendService as unknown as TenantSpendService,
      50,
    );
    spendService.reserve.mockRejectedValueOnce(
      new TenantSpendLimitExceededError('tenant-a', 1, 50),
    );

    await expect(provider.generate(request)).rejects.toBeInstanceOf(TenantSpendLimitExceededError);
    expect(inner.calls).toHaveLength(0);
    expect(spendService.release).not.toHaveBeenCalled();
    expect(spendService.settle).not.toHaveBeenCalled();
  });
});
