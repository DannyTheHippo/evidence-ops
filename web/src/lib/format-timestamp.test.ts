import { describe, expect, it } from 'vitest';
import { formatAbsoluteTimestamp, formatRelativeTimestamp } from './format-timestamp';

const NOW = new Date('2026-08-28T12:00:00.000Z');

describe('formatRelativeTimestamp', () => {
  it('picks minutes for a difference under an hour', () => {
    expect(formatRelativeTimestamp('2026-08-28T11:45:00.000Z', NOW)).toBe('15 minutes ago');
  });

  it('picks hours for a difference under a day', () => {
    expect(formatRelativeTimestamp('2026-08-28T10:00:00.000Z', NOW)).toBe('2 hours ago');
  });

  it('names yesterday rather than "1 day ago"', () => {
    expect(formatRelativeTimestamp('2026-08-27T12:00:00.000Z', NOW)).toBe('yesterday');
  });

  it('formats a future instant the same way, in the other direction', () => {
    expect(formatRelativeTimestamp('2026-08-31T12:00:00.000Z', NOW)).toBe('in 3 days');
  });

  it('returns the fallback for an invalid or empty timestamp rather than throwing', () => {
    expect(formatRelativeTimestamp('not-a-date', NOW)).toBe('—');
    expect(formatRelativeTimestamp('', NOW)).toBe('—');
  });
});

describe('formatAbsoluteTimestamp', () => {
  it('formats a valid timestamp to a non-empty, non-fallback string', () => {
    const result = formatAbsoluteTimestamp('2026-08-28T12:00:00.000Z');
    expect(result).not.toBe('—');
    expect(result).toContain('2026');
  });

  it('returns the fallback for an invalid or empty timestamp rather than "Invalid Date"', () => {
    expect(formatAbsoluteTimestamp('not-a-date')).toBe('—');
    expect(formatAbsoluteTimestamp('')).toBe('—');
  });
});
