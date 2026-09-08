import { canonicalJson } from '../../../src/shared/utils/canonical-json.util';

describe('canonicalJson', () => {
  it.each([
    ['null', null, 'null'],
    ['true', true, 'true'],
    ['false', false, 'false'],
    ['a string', 'hello', '"hello"'],
    ['a string requiring escaping', 'a"b', '"a\\"b"'],
    ['zero', 0, '0'],
    ['a negative number', -12.5, '-12.5'],
    ['an empty array', [], '[]'],
    ['an empty object', {}, '{}'],
  ])('should serialize %s', (_description, input, expected) => {
    expect(canonicalJson(input)).toBe(expected);
  });

  it('should sort object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('should produce identical output for structurally equal objects built in different key orders', () => {
    const first = { z: 1, a: { d: 4, b: 3 }, m: [1, { y: 2, x: 1 }] };
    const second = { a: { b: 3, d: 4 }, m: [1, { x: 1, y: 2 }], z: 1 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('should sort keys at every depth of nesting', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('should omit an undefined-valued object property', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('should omit a function-valued object property', () => {
    expect(canonicalJson({ a: 1, b: () => 1 })).toBe('{"a":1}');
  });

  it('should omit a symbol-valued object property', () => {
    expect(canonicalJson({ a: 1, b: Symbol('s') })).toBe('{"a":1}');
  });

  it('should preserve array order and not sort array elements', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('should render an undefined array element as null', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('should render a function array element as null', () => {
    expect(canonicalJson([1, () => 1, 2])).toBe('[1,null,2]');
  });

  it('should render a symbol array element as null', () => {
    expect(canonicalJson([1, Symbol('s'), 2])).toBe('[1,null,2]');
  });

  it('should render an array hole as null', () => {
    expect(canonicalJson([1, , 3])).toBe('[1,null,3]');
  });

  it('should call toJSON on a Date instead of serializing its own properties', () => {
    expect(canonicalJson(new Date('2026-01-01T00:00:00.000Z'))).toBe('"2026-01-01T00:00:00.000Z"');
  });

  it('should call toJSON on any object exposing one, honouring the resulting shape', () => {
    const value = { toJSON: () => ({ b: 2, a: 1 }) };

    expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
  });

  it('should sort nested objects reached through an array', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('should throw a TypeError on NaN', () => {
    expect(() => canonicalJson(NaN)).toThrow(new TypeError('canonicalJson: non-finite number'));
  });

  it('should throw a TypeError on positive Infinity', () => {
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
  });

  it('should throw a TypeError on negative Infinity', () => {
    expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
  });

  it('should throw a TypeError on a non-finite number nested in an object', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
  });

  it('should throw a TypeError on a bigint', () => {
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });

  it('should throw a TypeError on a top-level undefined value', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it('should throw a TypeError on a top-level function value', () => {
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });

  it('should throw a TypeError on a top-level symbol value', () => {
    expect(() => canonicalJson(Symbol('s'))).toThrow(TypeError);
  });
});
