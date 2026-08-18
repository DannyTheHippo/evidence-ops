import { describe, expect, it } from 'vitest';
import { formatInterval } from './format-interval';

describe('formatInterval', () => {
  it('names the cadence in the coarsest unit the interval clears', () => {
    expect(formatInterval(86_400_000)).toBe('Every 1 day');
    expect(formatInterval(3_600_000)).toBe('Every 1 hour');
    expect(formatInterval(300_000)).toBe('Every 5 minutes');
    expect(formatInterval(1_000)).toBe('Every 1 second');
  });

  it('pluralises on the rounded value, not the raw interval', () => {
    expect(formatInterval(5_400_000)).toBe('Every 1.5 hours');
    expect(formatInterval(7_200_000)).toBe('Every 2 hours');
  });

  // A source with no interval still syncs on the tenant default, which the API never sends to the
  // client — naming that state is the only honest option, since any number here would be invented.
  it('names the default cadence rather than inventing a number', () => {
    expect(formatInterval(undefined)).toBe('Default interval');
    expect(formatInterval(0)).toBe('Default interval');
  });

  // Below a second there is no coarser unit left to pick, so the loop falls through.
  it('falls back to raw milliseconds below one second', () => {
    expect(formatInterval(250)).toBe('Every 250 ms');
  });
});
