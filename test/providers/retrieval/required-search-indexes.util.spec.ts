import { mongo } from 'mongoose';
import { RequiredSearchIndexesMissingError } from '../../../src/providers/retrieval/errors/required-search-indexes-missing.error';
import { assertRequiredSearchIndexesExist } from '../../../src/providers/retrieval/required-search-indexes.util';
import { SEARCH_INDEX, VECTOR_INDEX } from '../../../src/providers/retrieval/retrieval.constant';

/** Mocks the exact chain the util calls: `db.collection(COLLECTION).listSearchIndexes().toArray()`. */
function createMockDb(listed: readonly Record<string, unknown>[]): mongo.Db {
  const listSearchIndexes = jest.fn().mockReturnValue({
    toArray: jest.fn().mockResolvedValue(listed),
  });
  const collection = jest.fn().mockReturnValue({ listSearchIndexes });
  return { collection } as unknown as mongo.Db;
}

describe('assertRequiredSearchIndexesExist', () => {
  afterEach(() => jest.resetAllMocks());

  it('should resolve when both required indexes are present and queryable', async () => {
    const db = createMockDb([
      { name: SEARCH_INDEX, status: 'READY', queryable: true },
      { name: VECTOR_INDEX, status: 'READY', queryable: true },
    ]);

    await expect(assertRequiredSearchIndexesExist(db)).resolves.toBeUndefined();
  });

  it('should throw RequiredSearchIndexesMissingError naming the missing index when only one is present', async () => {
    const db = createMockDb([{ name: SEARCH_INDEX, status: 'READY', queryable: true }]);

    const error = await assertRequiredSearchIndexesExist(db).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RequiredSearchIndexesMissingError);
    expect((error as Error).message).toContain(VECTOR_INDEX);
    expect((error as Error).message).not.toContain('"' + SEARCH_INDEX + '" (not found)');
  });

  it('should throw RequiredSearchIndexesMissingError naming both indexes when neither is present', async () => {
    const db = createMockDb([]);

    const error = await assertRequiredSearchIndexesExist(db).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RequiredSearchIndexesMissingError);
    expect((error as Error).message).toContain(SEARCH_INDEX);
    expect((error as Error).message).toContain(VECTOR_INDEX);
    // The subtlety `migrate:up` alone does not fix: only surfaced for the "missing" kind.
    expect((error as Error).message).toContain('migrate:up');
    expect((error as Error).message).toContain('0003-search-indexes.ts');
  });

  it('should throw RequiredSearchIndexesMissingError when an index is present but status is not READY', async () => {
    const db = createMockDb([
      { name: SEARCH_INDEX, status: 'BUILDING', queryable: false },
      { name: VECTOR_INDEX, status: 'READY', queryable: true },
    ]);

    const error = await assertRequiredSearchIndexesExist(db).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RequiredSearchIndexesMissingError);
    expect((error as Error).message).toContain(SEARCH_INDEX);
    expect((error as Error).message).toContain('status "BUILDING"');
    // The mid-build case must not tell the reader to clear the migrate-mongo changelog — that
    // recovery path is only correct for a genuinely missing index (see the error's own doc
    // comment on why deleting the row for a mid-build index would be actively wrong).
    expect((error as Error).message).not.toContain('migrate:up');
  });

  it('should throw RequiredSearchIndexesMissingError when an index reports READY but queryable is false', async () => {
    const db = createMockDb([
      { name: SEARCH_INDEX, status: 'READY', queryable: true },
      { name: VECTOR_INDEX, status: 'READY', queryable: false },
    ]);

    const error = await assertRequiredSearchIndexesExist(db).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RequiredSearchIndexesMissingError);
    expect((error as Error).message).toContain(VECTOR_INDEX);
    expect((error as Error).message).toContain('queryable=false');
  });
});
