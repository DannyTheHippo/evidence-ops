import { describe, expect, it } from 'vitest';
import { clampPageSize, clampSkip, pickOption } from './paging';

const OPTIONS = [25, 50, 100] as const;

describe('clampPageSize', () => {
  it.each([
    ['25', 25],
    ['7', 25],
    ['abc', 25],
    ['', 25],
    ['25.5', 25],
    ['-25', 25],
    ['1e2', 100],
  ])('reads %j as %i', (raw, expected) => {
    expect(clampPageSize(raw, OPTIONS, 25)).toBe(expected);
  });

  it('returns the fallback, not an option, when the value is outside the options', () => {
    expect(clampPageSize('7', [10, 20], 20)).toBe(20);
  });
});

describe('clampSkip', () => {
  it.each([
    ['0', 0],
    ['50', 50],
    ['-1', 0],
    ['2.5', 0],
    ['x', 0],
    ['', 0],
  ])('reads %j as %i', (raw, expected) => {
    expect(clampSkip(raw)).toBe(expected);
  });
});

describe('pickOption', () => {
  const FIELDS = ['createdAt', 'name'] as const;

  it.each([
    ['createdAt', 'createdAt'],
    ['name', 'name'],
    ['bogus', 'createdAt'],
    ['', 'createdAt'],
  ])('reads %j as %j', (raw, expected) => {
    expect(pickOption(raw, FIELDS, 'createdAt')).toBe(expected);
  });

  it('falls back for a value outside asc/desc', () => {
    expect(pickOption('up', ['asc', 'desc'] as const, 'desc')).toBe('desc');
  });
});
