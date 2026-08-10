import type { Db } from 'mongodb';
import {
  SearchIndexNotReadyError,
  waitForSearchIndexReady,
} from '../../../../src/features/evidence/retrieval/search-index-readiness.util';

/**
 * Mocks the exact chain `waitForSearchIndexReady` calls:
 * `db.collection(name).listSearchIndexes(indexName).toArray()`. `toArrayImpl` drives what each
 * poll "sees" from Atlas.
 */
function createMockDb(toArrayImpl: jest.Mock): Db {
  const listSearchIndexes = jest.fn().mockReturnValue({ toArray: toArrayImpl });
  const collection = jest.fn().mockReturnValue({ listSearchIndexes });
  return { collection } as unknown as Db;
}

describe('waitForSearchIndexReady', () => {
  afterEach(() => jest.resetAllMocks());

  it('should resolve once the index reports READY and queryable', async () => {
    const toArray = jest
      .fn()
      .mockResolvedValue([{ name: 'idx', status: 'READY', queryable: true }]);
    const db = createMockDb(toArray);

    await expect(
      waitForSearchIndexReady(db, 'evidence_chunks', 'idx', { pollIntervalMs: 5 }),
    ).resolves.toBeUndefined();
  });

  it('should keep polling while the index is still building, then resolve once ready', async () => {
    const toArray = jest
      .fn()
      .mockResolvedValueOnce([{ name: 'idx', status: 'PENDING', queryable: false }])
      .mockResolvedValueOnce([{ name: 'idx', status: 'BUILDING', queryable: false }])
      .mockResolvedValueOnce([{ name: 'idx', status: 'READY', queryable: true }]);
    const db = createMockDb(toArray);

    await waitForSearchIndexReady(db, 'evidence_chunks', 'idx', { pollIntervalMs: 5 });

    expect(toArray).toHaveBeenCalledTimes(3);
  });

  it('should throw SearchIndexNotReadyError once the timeout elapses without READY+queryable', async () => {
    const toArray = jest
      .fn()
      .mockResolvedValue([{ name: 'idx', status: 'BUILDING', queryable: false }]);
    const db = createMockDb(toArray);

    await expect(
      waitForSearchIndexReady(db, 'evidence_chunks', 'idx', { timeoutMs: 20, pollIntervalMs: 10 }),
    ).rejects.toThrow(SearchIndexNotReadyError);
  });

  it('should report "not found" in the timeout message when the index never appears', async () => {
    const toArray = jest.fn().mockResolvedValue([]);
    const db = createMockDb(toArray);

    await expect(
      waitForSearchIndexReady(db, 'evidence_chunks', 'missing', {
        timeoutMs: 15,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('should fail fast with SearchIndexNotReadyError when the build reports FAILED', async () => {
    const toArray = jest
      .fn()
      .mockResolvedValue([{ name: 'idx', status: 'FAILED', queryable: false }]);
    const db = createMockDb(toArray);

    await expect(
      waitForSearchIndexReady(db, 'evidence_chunks', 'idx', {
        timeoutMs: 120_000,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/FAILED/);
    // Fails on the first poll rather than exhausting the (deliberately large) timeout budget.
    expect(toArray).toHaveBeenCalledTimes(1);
  });
});
