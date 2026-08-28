import { Db, ObjectId } from 'mongodb';
import {
  createSearchChunkCountProbe,
  createSearchIndexesWhenReady,
  createVectorChunkProbe,
  SearchIndexNotReadyError,
  SearchIndexServiceUnavailableError,
  waitForIndexConvergence,
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

/**
 * Mocks the chain both `waitForIndexConvergence`'s status-readiness phase and the probe builders
 * below need: `listSearchIndexes` (status) alongside `aggregate` (probe query). Defaults status to
 * already `READY`/`queryable` — `waitForIndexConvergence`'s own tests below only care about the
 * probe phase, and `waitForSearchIndexReady`'s status-polling behaviour already has its own
 * coverage above. Returns the `aggregate` mock alongside `db` so the probe-builder tests below can
 * assert on the exact pipeline each probe sends, not only the boolean it resolves to.
 */
function createMockDbWithAggregate(aggregateToArrayImpl: jest.Mock): {
  db: Db;
  aggregate: jest.Mock;
} {
  const listSearchIndexes = jest.fn().mockReturnValue({
    toArray: jest.fn().mockResolvedValue([{ name: 'idx', status: 'READY', queryable: true }]),
  });
  const aggregate = jest.fn().mockReturnValue({ toArray: aggregateToArrayImpl });
  const collection = jest.fn().mockReturnValue({ listSearchIndexes, aggregate });
  return { db: { collection } as unknown as Db, aggregate };
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

describe('waitForIndexConvergence', () => {
  afterEach(() => jest.resetAllMocks());

  it('should resolve converged: true once the probe reports true on the first poll', async () => {
    const { db } = createMockDbWithAggregate(jest.fn());
    const probe = jest.fn().mockResolvedValue(true);

    await expect(
      waitForIndexConvergence(db, 'evidence_chunks', 'idx', probe, { pollIntervalMs: 5 }),
    ).resolves.toEqual({ converged: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('should keep polling the probe after status readiness, then resolve converged: true', async () => {
    const { db } = createMockDbWithAggregate(jest.fn());
    const probe = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForIndexConvergence(db, 'evidence_chunks', 'idx', probe, { pollIntervalMs: 5 });

    expect(probe).toHaveBeenCalledTimes(3);
  });

  // FAILURE DIRECTION: `'throw'` is the default — the eval harness (`eval/ingest-fixtures.ts`)
  // relies on never having to pass it explicitly to get the fail-closed behaviour.
  it('should throw SearchIndexNotReadyError when the probe never converges and onTimeout is left at its default', async () => {
    const { db } = createMockDbWithAggregate(jest.fn());
    const probe = jest.fn().mockResolvedValue(false);

    await expect(
      waitForIndexConvergence(db, 'evidence_chunks', 'idx', probe, {
        timeoutMs: 20,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(SearchIndexNotReadyError);
  });

  // FAILURE DIRECTION: `onTimeout: 'degrade'` is what `IngestionService.ingestVersion` opts into
  // — a probe that never converges must resolve, not hang or reject, so an already-successful
  // upload never turns into a failed request.
  it('should resolve converged: false without throwing when the probe never converges and onTimeout is "degrade"', async () => {
    const { db } = createMockDbWithAggregate(jest.fn());
    const probe = jest.fn().mockResolvedValue(false);

    await expect(
      waitForIndexConvergence(db, 'evidence_chunks', 'idx', probe, {
        timeoutMs: 20,
        pollIntervalMs: 10,
        onTimeout: 'degrade',
      }),
    ).resolves.toEqual({ converged: false });
  });

  // The status-readiness phase's own FAILURE DIRECTION never changes with `onTimeout`: a build
  // the driver itself reports `FAILED` is a build failure, not a "the user shouldn't be blocked"
  // case — `onTimeout: 'degrade'` only governs the probe phase that runs after status succeeds.
  it('should propagate a status-readiness failure even when onTimeout is "degrade"', async () => {
    const toArray = jest
      .fn()
      .mockResolvedValue([{ name: 'idx', status: 'FAILED', queryable: false }]);
    const db = createMockDb(toArray);
    const probe = jest.fn();

    await expect(
      waitForIndexConvergence(db, 'evidence_chunks', 'idx', probe, {
        timeoutMs: 120_000,
        pollIntervalMs: 5,
        onTimeout: 'degrade',
      }),
    ).rejects.toThrow(/FAILED/);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('createSearchChunkCountProbe', () => {
  afterEach(() => jest.resetAllMocks());

  it('should report converged once the search index returns at least the expected chunk count, filtering by a coerced ObjectId', async () => {
    const aggregateToArray = jest.fn().mockResolvedValue([{ count: 3 }]);
    const { db, aggregate } = createMockDbWithAggregate(aggregateToArray);
    const documentVersionId = new ObjectId().toHexString();

    const probe = createSearchChunkCountProbe(
      db,
      'evidence_chunks',
      'evidence_chunks_search',
      documentVersionId,
      3,
    );

    await expect(probe()).resolves.toBe(true);
    // The search index mapping declares `documentVersionId` as `objectId`
    // (`migrations/0001-baseline.ts`) — a raw string filter value matches nothing, so this must coerce via
    // `new ObjectId(...)` rather than pass the hex string straight through.
    expect(aggregate).toHaveBeenCalledWith([
      {
        $search: {
          index: 'evidence_chunks_search',
          compound: {
            filter: [
              { equals: { path: 'documentVersionId', value: new ObjectId(documentVersionId) } },
            ],
          },
        },
      },
      { $count: 'count' },
    ]);
  });

  it('should report not converged while the search index returns fewer than the expected chunk count', async () => {
    const aggregateToArray = jest.fn().mockResolvedValue([{ count: 2 }]);
    const { db } = createMockDbWithAggregate(aggregateToArray);

    const probe = createSearchChunkCountProbe(
      db,
      'evidence_chunks',
      'evidence_chunks_search',
      new ObjectId().toHexString(),
      3,
    );

    await expect(probe()).resolves.toBe(false);
  });

  it('should report not converged when the count stage returns no document at all', async () => {
    const aggregateToArray = jest.fn().mockResolvedValue([]);
    const { db } = createMockDbWithAggregate(aggregateToArray);

    const probe = createSearchChunkCountProbe(
      db,
      'evidence_chunks',
      'evidence_chunks_search',
      new ObjectId().toHexString(),
      1,
    );

    await expect(probe()).resolves.toBe(false);
  });
});

describe('createVectorChunkProbe', () => {
  afterEach(() => jest.resetAllMocks());

  it('should report converged once the known chunk id comes back from $vectorSearch, filtered by tenant', async () => {
    const aggregateToArray = jest
      .fn()
      .mockResolvedValue([{ _id: 'other-chunk' }, { _id: 'known-chunk' }]);
    const { db, aggregate } = createMockDbWithAggregate(aggregateToArray);

    const probe = createVectorChunkProbe(
      db,
      'evidence_chunks',
      'evidence_chunks_vector',
      'tenant-a',
      'known-chunk',
      [0.1, 0.2, 0.3],
    );

    await expect(probe()).resolves.toBe(true);
    // Only `tenantId` is declared a `filter` field on the vector index mapping
    // (`migrations/0001-baseline.ts`), and the vector path itself is `embedding` — a regression on either
    // means this probe never converges (see this util's own `createVectorChunkProbe` doc comment).
    expect(aggregate).toHaveBeenCalledWith([
      {
        $vectorSearch: {
          index: 'evidence_chunks_vector',
          path: 'embedding',
          queryVector: [0.1, 0.2, 0.3],
          numCandidates: 50,
          limit: 5,
          filter: { tenantId: { $eq: 'tenant-a' } },
        },
      },
      { $project: { _id: 1 } },
    ]);
  });

  it('should report not converged while the known chunk id is absent from $vectorSearch results', async () => {
    const aggregateToArray = jest.fn().mockResolvedValue([{ _id: 'other-chunk' }]);
    const { db } = createMockDbWithAggregate(aggregateToArray);

    const probe = createVectorChunkProbe(
      db,
      'evidence_chunks',
      'evidence_chunks_vector',
      'tenant-a',
      'known-chunk',
      [0.1, 0.2, 0.3],
    );

    await expect(probe()).resolves.toBe(false);
  });
});

/**
 * Mocks the chain `createSearchIndexesWhenReady` calls:
 * `db.collection(name).createSearchIndexes(indexes)`. Returns the mock so each test can assert how
 * many attempts were made — the retry behaviour is the whole point, so a test that only checked the
 * resolved value would pass whether or not any retry happened.
 */
function createMockDbWithCreateSearchIndexes(impl: jest.Mock): {
  db: Db;
  createSearchIndexes: jest.Mock;
} {
  const collection = jest.fn().mockReturnValue({ createSearchIndexes: impl });
  return { db: { collection } as unknown as Db, createSearchIndexes: impl };
}

const UNREACHABLE = new Error('Error connecting to Search Index Management service.');
const INDEXES = [{ name: 'idx', definition: { mappings: { dynamic: true } } }];

describe('createSearchIndexesWhenReady', () => {
  afterEach(() => jest.resetAllMocks());

  it('should create the indexes on the first attempt when the service is already reachable', async () => {
    const { db, createSearchIndexes } = createMockDbWithCreateSearchIndexes(
      jest.fn().mockResolvedValue(['idx']),
    );

    await createSearchIndexesWhenReady(db, 'evidence_chunks', INDEXES);

    expect(createSearchIndexes).toHaveBeenCalledTimes(1);
    expect(createSearchIndexes).toHaveBeenCalledWith(INDEXES);
  });

  it('should retry while the search service is unreachable and succeed once it comes up', async () => {
    const { db, createSearchIndexes } = createMockDbWithCreateSearchIndexes(
      jest
        .fn()
        .mockRejectedValueOnce(UNREACHABLE)
        .mockRejectedValueOnce(UNREACHABLE)
        .mockResolvedValue(['idx']),
    );

    await createSearchIndexesWhenReady(db, 'evidence_chunks', INDEXES, { retryIntervalMs: 0 });

    expect(createSearchIndexes).toHaveBeenCalledTimes(3);
  });

  it('should propagate an unrelated error on the first attempt rather than retrying it', async () => {
    const other = new Error('index already exists');
    const { db, createSearchIndexes } = createMockDbWithCreateSearchIndexes(
      jest.fn().mockRejectedValue(other),
    );

    await expect(
      createSearchIndexesWhenReady(db, 'evidence_chunks', INDEXES, { retryIntervalMs: 0 }),
    ).rejects.toBe(other);
    expect(createSearchIndexes).toHaveBeenCalledTimes(1);
  });

  it('should throw SearchIndexServiceUnavailableError once the budget is exhausted, never resolve', async () => {
    const { db, createSearchIndexes } = createMockDbWithCreateSearchIndexes(
      jest.fn().mockRejectedValue(UNREACHABLE),
    );

    await expect(
      createSearchIndexesWhenReady(db, 'evidence_chunks', INDEXES, {
        timeoutMs: 0,
        retryIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(SearchIndexServiceUnavailableError);
    expect(createSearchIndexes).toHaveBeenCalledTimes(1);
  });

  it('should name the wait and the underlying error so a slow start is distinguishable from a dead service', async () => {
    const { db } = createMockDbWithCreateSearchIndexes(jest.fn().mockRejectedValue(UNREACHABLE));

    await expect(
      createSearchIndexesWhenReady(db, 'evidence_chunks', INDEXES, {
        timeoutMs: 0,
        retryIntervalMs: 0,
      }),
    ).rejects.toThrow(/still unreachable after \d+ms — last error: .*Search Index Management/);
  });
});
