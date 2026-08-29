import { escapeRegex } from '../../../src/shared/utils/escape-regex.util';

describe('escapeRegex', () => {
  it('should return a plain alphanumeric string untouched', () => {
    expect(escapeRegex('DealRoom42')).toBe('DealRoom42');
  });

  it('should escape every regex metacharacter', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('should treat a metacharacter as a literal when matched via the escaped pattern', () => {
    const pattern = new RegExp(escapeRegex('a.b(c)'));
    expect(pattern.test('a.b(c)')).toBe(true);
    expect(pattern.test('aXbYc')).toBe(false);
  });

  it('should not catastrophically backtrack on a pathological input', () => {
    const hostile = '('.repeat(5000);
    const start = Date.now();
    const pattern = new RegExp(escapeRegex(hostile));
    pattern.test('x');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('should return an empty string untouched', () => {
    expect(escapeRegex('')).toBe('');
  });
});
