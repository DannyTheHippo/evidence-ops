import { resolveSort } from '../../../src/shared/utils/resolve-sort.util';

describe('resolveSort', () => {
  it('should use the caller-supplied field and direction when both are given', () => {
    expect(resolveSort('title', 'asc', 'createdAt', 'desc')).toEqual({ title: 1 });
  });

  it('should fall back to the default field when none is supplied', () => {
    expect(resolveSort(undefined, 'asc', 'createdAt', 'desc')).toEqual({ createdAt: 1 });
  });

  it('should fall back to the default direction when none is supplied', () => {
    expect(resolveSort('title', undefined, 'createdAt', 'desc')).toEqual({ title: -1 });
  });

  it('should fall back to both defaults when neither field nor direction is supplied', () => {
    expect(resolveSort(undefined, undefined, 'createdAt', 'desc')).toEqual({ createdAt: -1 });
  });

  it.each([
    ['asc', 1],
    ['desc', -1],
  ] as const)('should map a %s direction to the Mongo sort value %d', (direction, expected) => {
    expect(resolveSort('title', direction, 'createdAt', 'desc')).toEqual({ title: expected });
  });
});
