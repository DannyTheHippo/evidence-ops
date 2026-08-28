import {
  MAX_ENTRIES,
  QueryEmbeddingCacheService,
  TTL_MS,
} from '../../../../src/features/evidence/qa/query-embedding-cache.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import type { MockLogger } from '../../../utils/get-mock-logger';
import { getMockLogger } from '../../../utils/get-mock-logger';

describe('QueryEmbeddingCacheService', () => {
  let service: QueryEmbeddingCacheService;
  let mockLogger: MockLogger;

  // Bracket-typed access to the private `entries` map — the only way to force a read/write
  // failure without a fake Map subclass, and how the eviction test confirms which key survived.
  const entriesOf = (target: QueryEmbeddingCacheService): Map<string, unknown> =>
    (target as unknown as { entries: Map<string, unknown> }).entries;

  beforeEach(() => {
    mockLogger = getMockLogger();
    service = new QueryEmbeddingCacheService(mockLogger as unknown as AppLogger);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
  });

  it('should call compute on a cache miss and return its result', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);

    const result = await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );

    expect(result).toEqual([1, 2, 3]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should spend one compute call for a repeated identical tenant + text + model', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);
    const key = { tenantId: 'default', text: 'cap rate', model: 'voyage-3' };

    await service.getOrCompute(key, compute);
    await service.getOrCompute(key, compute);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should spend a second compute call for the same text under a different tenant', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);

    await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );
    await service.getOrCompute({ tenantId: 'acme', text: 'cap rate', model: 'voyage-3' }, compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should spend a second compute call for a different query text under the same tenant', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);

    await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );
    await service.getOrCompute(
      { tenantId: 'default', text: 'occupancy rate', model: 'voyage-3' },
      compute,
    );

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should spend a second compute call for the same tenant and text under a different model', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);

    await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );
    await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-4' },
      compute,
    );

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should spend a second compute call once the entry has expired', async () => {
    jest.useFakeTimers();
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);
    const key = { tenantId: 'default', text: 'cap rate', model: 'voyage-3' };

    await service.getOrCompute(key, compute);
    jest.advanceTimersByTime(TTL_MS + 1);
    await service.getOrCompute(key, compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('should evict the least-recently-used entry once the cache exceeds its bound', async () => {
    const compute = jest.fn().mockResolvedValue([1, 2, 3]);

    for (let index = 0; index < MAX_ENTRIES; index += 1) {
      await service.getOrCompute(
        { tenantId: 'default', text: `query-${index}`, model: 'voyage-3' },
        compute,
      );
    }
    // One more insert past the bound must evict the oldest entry (`query-0`).
    await service.getOrCompute(
      { tenantId: 'default', text: 'query-overflow', model: 'voyage-3' },
      compute,
    );
    compute.mockClear();

    await service.getOrCompute(
      { tenantId: 'default', text: 'query-0', model: 'voyage-3' },
      compute,
    );

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should fall through to a live compute and warn when reading the cache fails', async () => {
    jest.spyOn(entriesOf(service), 'get').mockImplementationOnce(() => {
      throw new Error('read boom');
    });
    const compute = jest.fn().mockResolvedValue([9, 9, 9]);

    const result = await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );

    expect(result).toEqual([9, 9, 9]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('cache read failed'));
  });

  it('should still return the computed vector and warn when writing the cache fails', async () => {
    jest.spyOn(entriesOf(service), 'set').mockImplementationOnce(() => {
      throw new Error('write boom');
    });
    const compute = jest.fn().mockResolvedValue([4, 5, 6]);

    const result = await service.getOrCompute(
      { tenantId: 'default', text: 'cap rate', model: 'voyage-3' },
      compute,
    );

    expect(result).toEqual([4, 5, 6]);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('cache write failed'));
  });

  it('should propagate a compute failure instead of swallowing it', async () => {
    const compute = jest.fn().mockRejectedValue(new Error('embedding provider down'));

    await expect(
      service.getOrCompute({ tenantId: 'default', text: 'cap rate', model: 'voyage-3' }, compute),
    ).rejects.toThrow('embedding provider down');
  });
});
