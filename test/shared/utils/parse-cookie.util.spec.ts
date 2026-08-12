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

  it('should keep the first occurrence and skip a duplicate name', () => {
    expect(parseCookieHeader('a=first; a=second')).toEqual({ a: 'first' });
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
