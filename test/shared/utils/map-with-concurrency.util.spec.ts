import { mapWithConcurrency } from '../../../src/shared/utils/map-with-concurrency.util';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('should resolve to an empty array without calling fn when items is empty', async () => {
    const fn = jest.fn();

    const result = await mapWithConcurrency([], 3, fn);

    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('should process every item, in order, when limit exceeds the item count', async () => {
    const fn = jest.fn((item: number) => Promise.resolve(item * 2));

    const result = await mapWithConcurrency([1, 2, 3], 10, fn);

    expect(result).toEqual([2, 4, 6]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should run calls one at a time, in order, when limit is 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = jest.fn(async (item: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item * 2;
    });

    const result = await mapWithConcurrency([1, 2, 3], 1, fn);

    expect(result).toEqual([2, 4, 6]);
    expect(maxInFlight).toBe(1);
  });

  it('should never have more than `limit` calls in flight at once', async () => {
    const deferreds = Array.from({ length: 5 }, () => createDeferred<number>());
    const fn = jest.fn((_item: number, index: number) => deferreds[index].promise);

    const resultPromise = mapWithConcurrency([0, 1, 2, 3, 4], 2, fn);
    expect(fn).toHaveBeenCalledTimes(2);

    deferreds[0].resolve(0);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(3);

    deferreds[1].resolve(1);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(4);

    deferreds[2].resolve(2);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(5);

    deferreds[3].resolve(3);
    deferreds[4].resolve(4);

    await expect(resultPromise).resolves.toEqual([0, 1, 2, 3, 4]);
  });

  it('should preserve input order in the results even when a later item resolves first', async () => {
    const deferredA = createDeferred<string>();
    const deferredB = createDeferred<string>();
    const fn = jest.fn((item: string) => (item === 'a' ? deferredA.promise : deferredB.promise));

    const resultPromise = mapWithConcurrency(['a', 'b'], 2, fn);
    deferredB.resolve('B-result');
    deferredA.resolve('A-result');

    await expect(resultPromise).resolves.toEqual(['A-result', 'B-result']);
  });

  it('should reject with the underlying error and call fn no further times once an item rejects', async () => {
    const error = new Error('boom');
    const fn = jest.fn((item: number) =>
      item === 2 ? Promise.reject(error) : Promise.resolve(item),
    );

    await expect(mapWithConcurrency([1, 2, 3], 1, fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).not.toHaveBeenCalledWith(3, 2);
  });

  it('should stop a surviving worker from starting a further item once another worker in the pool rejects', async () => {
    const error = new Error('boom');
    const deferredB = createDeferred<number>();
    const fn = jest.fn((item: number) => {
      if (item === 0) {
        return Promise.reject(error);
      }
      if (item === 1) {
        return deferredB.promise;
      }
      return Promise.resolve(item);
    });

    const resultPromise = mapWithConcurrency([0, 1, 2], 2, fn);
    deferredB.resolve(1);

    await expect(resultPromise).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).not.toHaveBeenCalledWith(2, 2);
  });
});
