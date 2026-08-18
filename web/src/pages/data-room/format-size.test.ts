import { describe, expect, it } from 'vitest';
import { formatBytes } from './format-size';

describe('formatBytes', () => {
  it('renders whole bytes under 1 KB', () => {
    expect(formatBytes(100)).toBe('100 B');
  });

  it('renders kilobytes to one decimal place', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('renders megabytes for large files', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('caps scaling at gigabytes', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});
