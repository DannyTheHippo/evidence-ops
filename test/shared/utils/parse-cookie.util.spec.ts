import { parseCookieHeader } from '../../../src/shared/utils/parse-cookie.util';

describe('parseCookieHeader', () => {
  it('should return an empty map when the header is absent', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('should return an empty map when the header is an empty string', () => {
    expect(parseCookieHeader('')).toEqual({});
  });

  it('should parse a single pair', () => {
    expect(parseCookieHeader('eo_session=abc123')).toEqual({ eo_session: 'abc123' });
  });

  it('should parse multiple pairs', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('should tolerate whitespace around the `;` separator', () => {
    expect(parseCookieHeader('a=1;   b=2  ;c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('should keep everything after the first `=` when the value itself contains one', () => {
    expect(parseCookieHeader('token=abc=def')).toEqual({ token: 'abc=def' });
  });

  it('should decode a URL-encoded value', () => {
    expect(parseCookieHeader('name=a%20b%3Dc')).toEqual({ name: 'a b=c' });
  });

  // Fail-closed regression: RFC 6265 §5.4 lets a longer-`Path` cookie (e.g. one planted by a
  // sibling subdomain or via XSS) arrive before the legitimate one. Picking either value would be
  // a confident accept of a possibly-wrong identity, so a duplicated name is excluded entirely
  // rather than resolved by position — an ambiguous credential must produce a rejection, never a
  // guess.
  it('should exclude a name that appears more than once, rather than picking either value', () => {
    expect(parseCookieHeader('a=first; a=second')).toEqual({});
  });

  it('should exclude a name that appears more than once even alongside an unambiguous cookie', () => {
    expect(parseCookieHeader('a=first; ok=1; a=second')).toEqual({ ok: '1' });
  });

  it('should exclude a name whose first occurrence failed to decode and second occurrence was valid', () => {
    expect(parseCookieHeader('a=%%; a=valid')).toEqual({});
  });

  it('should resolve the __Host- prefixed name as a distinct key from the unprefixed one', () => {
    expect(parseCookieHeader('__Host-eo_session=secure; eo_session=plain')).toEqual({
      '__Host-eo_session': 'secure',
      eo_session: 'plain',
    });
  });

  // Prototype-pollution regression: `cookies` is a plain object literal, so `__proto__` is not an
  // own-property key but an accessor inherited from Object.prototype. Assigning a non-object value
  // through it is a spec no-op — nothing is set, nothing is returned — which is what "none may
  // pollute or be returned" requires. `constructor`/`hasOwnProperty` are ordinary own properties
  // that merely shadow the inherited method for this one object; parsing them is safe.
  it('should not pollute or return a cookie literally named __proto__', () => {
    const result = parseCookieHeader('__proto__=evil; ok=1');

    expect(result).toEqual({ ok: '1' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
  });

  it('should parse a cookie named constructor without touching the prototype', () => {
    expect(parseCookieHeader('constructor=abc')).toEqual({ constructor: 'abc' });
  });

  it('should parse a cookie named hasOwnProperty without touching the prototype', () => {
    expect(parseCookieHeader('hasOwnProperty=abc')).toEqual({ hasOwnProperty: 'abc' });
  });

  // Fail-open regression: `%` sequences that are not valid percent-encoding make
  // `decodeURIComponent` throw. The malformed segment is skipped rather than the whole parse
  // aborting, so a request with one bad cookie still resolves the rest.
  it('should skip a segment whose value is not valid percent-encoding', () => {
    expect(parseCookieHeader('bad=%%; ok=1')).toEqual({ ok: '1' });
  });

  it('should skip a segment with no `=` separator', () => {
    expect(parseCookieHeader('justaname; ok=1')).toEqual({ ok: '1' });
  });

  it('should skip a segment with an empty name', () => {
    expect(parseCookieHeader('=novalue; ok=1')).toEqual({ ok: '1' });
  });
});
