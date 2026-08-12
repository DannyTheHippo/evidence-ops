/**
 * Maps `items` through `fn` with at most `limit` concurrent calls in flight. Results resolve in
 * input order regardless of which call settles first — an equal-index worker pool writes each
 * result to its own slot in a preallocated array rather than pushing in completion order.
 *
 * Fails closed: the first rejection stops every worker from picking up further items (already
 * in-flight calls still finish, but none of them start a new one), and the returned promise
 * rejects with that first error once every worker has stopped. A batch that is already doomed
 * should not keep spending calls on it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  const poolSize = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length && errors.length === 0) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        errors.push(error);
      }
    }
  };

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  if (errors.length > 0) {
    throw errors[0];
  }

  return results;
}
