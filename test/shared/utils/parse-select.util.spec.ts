import { parseSelect } from '../../../src/shared/utils/parse-select.util';

describe('parseSelect', () => {
  it('should return an empty array when raw is undefined', () => {
    expect(parseSelect(undefined)).toEqual([]);
  });

  it('should return an empty array when raw is an empty string', () => {
    expect(parseSelect('')).toEqual([]);
  });

  it('should return an empty array for a non-string, non-array raw value', () => {
    expect(parseSelect(42)).toEqual([]);
  });

  it('should split a comma-separated string and trim each field', () => {
    expect(parseSelect('name, status , amount')).toEqual(['name', 'status', 'amount']);
  });

  it('should accept the repeated-param array form Express produces for `?select=a&select=b`', () => {
    expect(parseSelect(['name', 'status'])).toEqual(['name', 'status']);
  });

  it('should split commas within individual array entries as well', () => {
    expect(parseSelect(['name,status', 'amount'])).toEqual(['name', 'status', 'amount']);
  });

  it('should drop empty entries produced by consecutive or trailing commas', () => {
    expect(parseSelect('name,,status,')).toEqual(['name', 'status']);
  });

  it('should drop entries that are only whitespace', () => {
    expect(parseSelect('name,   ,status')).toEqual(['name', 'status']);
  });

  it('should drop non-string entries when raw is an array', () => {
    // Express query parsing can hand back numbers/null/undefined for malformed repeated params;
    // only string entries are field names.
    expect(parseSelect([123, 'name', null, undefined, true])).toEqual(['name']);
  });

  it('should keep a duplicated field name as-is, without deduping', () => {
    expect(parseSelect('name,name')).toEqual(['name', 'name']);
  });
});
