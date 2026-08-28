import type { SortDirection } from '../constants/sort.constant';

/*
 * Builds the Mongoose `sort` option from a caller-supplied field/direction pair, falling back to
 * `defaultField`/`defaultDirection` when either is omitted. `field` is trusted to already be
 * validated against the caller's own allowlist (each list DTO's `@IsIn`) — this utility never
 * chooses among several fields, it only resolves the one it is given.
 */
export const resolveSort = (
  field: string | undefined,
  direction: SortDirection | undefined,
  defaultField: string,
  defaultDirection: SortDirection,
): Record<string, 1 | -1> => ({
  [field ?? defaultField]: (direction ?? defaultDirection) === 'asc' ? 1 : -1,
});
