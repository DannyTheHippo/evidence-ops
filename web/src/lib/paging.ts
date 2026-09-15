/**
 * Reads a `?limit=` URL value as a page size. Returns the parsed integer when `options` contains
 * it, otherwise `fallback`, so a hand-edited URL cannot request a size the server refuses or the
 * page-size select cannot represent.
 */
export function clampPageSize(raw: string, options: readonly number[], fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && options.includes(parsed) ? parsed : fallback;
}

/**
 * Reads a `?skip=` URL value as a list offset. Returns the parsed value when it is a non-negative
 * integer, otherwise `0`.
 */
export function clampSkip(raw: string): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Reads a `?sort=`/`?sortDir=` URL value against the field or direction set a list page actually
 * supports. Returns `raw` narrowed to `T` when it is one of `options`, otherwise `fallback`, so a
 * hand-edited or stale URL falls back to the page's default rather than reaching the API with a
 * value its `@IsIn` decorator refuses.
 */
export function pickOption<T extends string>(raw: string, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
