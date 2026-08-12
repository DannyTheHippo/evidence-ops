import { pickFields } from '../../../src/shared/utils/pick-fields.util';

describe('pickFields', () => {
  it('should return null untouched', () => {
    expect(pickFields(null, ['name'])).toBeNull();
  });

  it('should return a primitive untouched', () => {
    expect(pickFields('not-an-object', ['name'])).toBe('not-an-object');
  });

  it('should return an array untouched, without treating it as a resource-shaped object', () => {
    const source = [{ _id: '1' }, { _id: '2' }];
    expect(pickFields(source, ['name'])).toBe(source);
  });

  it('should return an object without an own `_id` untouched (e.g. health/info payloads)', () => {
    const source = { status: 'ok' };
    expect(pickFields(source, ['status'])).toBe(source);
  });

  it('should return only `_id` plus the requested fields that exist on the source', () => {
    const source = { _id: '1', name: 'Northgate', status: 'active', amount: 500 };
    expect(pickFields(source, ['name', 'status'])).toEqual({
      _id: '1',
      name: 'Northgate',
      status: 'active',
    });
  });

  it('should not duplicate `_id` when it is also requested as a field', () => {
    expect(pickFields({ _id: '1', name: 'Northgate' }, ['_id'])).toEqual({ _id: '1' });
  });

  it('should silently skip a requested field that does not exist on the source', () => {
    expect(pickFields({ _id: '1', name: 'Northgate' }, ['missing'])).toEqual({ _id: '1' });
  });

  it('should return just `_id` when no fields are requested', () => {
    expect(pickFields({ _id: '1', name: 'Northgate' }, [])).toEqual({ _id: '1' });
  });

  // Prototype-pollution regression: `__proto__` is not an own property of a plain object literal,
  // so `hasOwnProperty` reports false and the field is skipped rather than resolving to the
  // inherited accessor — the restrictive (safe) outcome for a field the caller never legitimately
  // set.
  it('should skip a requested field named __proto__ rather than resolving the inherited accessor', () => {
    const result = pickFields({ _id: '1', name: 'Northgate' }, ['__proto__', 'name']);

    expect(result).toEqual({ _id: '1', name: 'Northgate' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
