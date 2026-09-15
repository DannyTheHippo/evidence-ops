import { describe, expect, it } from 'vitest';
import { loginHrefFor, resolveReturnTo } from './return-to';

describe('loginHrefFor', () => {
  it('sends the root to plain /login', () => {
    expect(loginHrefFor({ pathname: '/', search: '' })).toBe('/login');
  });

  it('carries a deep link as an encoded next parameter', () => {
    expect(loginHrefFor({ pathname: '/documents/abc', search: '?skip=20' })).toBe(
      '/login?next=%2Fdocuments%2Fabc%3Fskip%3D20',
    );
  });

  it('sends /login itself to plain /login rather than nesting a next parameter', () => {
    expect(loginHrefFor({ pathname: '/login', search: '' })).toBe('/login');
  });

  it('sends /invite itself to plain /login rather than nesting a next parameter', () => {
    expect(loginHrefFor({ pathname: '/invite', search: '?token=abc' })).toBe('/login');
  });
});

const TAB = String.fromCharCode(9);
const BACKSLASH = String.fromCharCode(92);

// Every value here either resolves off-origin in a browser, carries a character a browser strips
// or reinterprets while parsing, or points back at an anonymous page. The raw `next` value is
// appended to `?next=` unchanged, so percent-encoded rows exercise the decode step.
const REFUSED_NEXT_VALUES: Array<{ family: string; next: string }> = [
  { family: 'control: tab between slashes', next: '%2F%09%2Fevil.example' },
  { family: 'control: line feed between slashes', next: '%2F%0A%2Fevil.example' },
  { family: 'control: carriage return between slashes', next: '%2F%0D%2Fevil.example' },
  { family: 'control: form feed between slashes', next: '%2F%0C%2Fevil.example' },
  { family: 'control: vertical tab between slashes', next: '%2F%0B%2Fevil.example' },
  { family: 'control: leading tab', next: '%09%2F%2Fevil.example' },
  { family: 'control: NUL inside the path', next: '%2Fsour%00ces' },
  { family: 'control: trailing line feed', next: '%2Fsources%0A' },
  { family: 'control: inside the query', next: '%2Fsources%3Fview%3D%01' },
  { family: 'control: inside the fragment', next: '%2Fsources%23row%0D' },
  { family: 'control: DEL', next: '%2Fsources%7F' },
  { family: 'control: C1 next-line', next: '%2F%C2%85%2Fevil.example' },
  { family: 'control: unencoded tab between slashes', next: `/${TAB}/evil.example` },
  { family: 'whitespace: space between slashes', next: '%2F%20%2Fevil.example' },
  { family: 'whitespace: leading space', next: '%20%2F%2Fevil.example' },
  { family: 'whitespace: no-break space', next: '%2F%C2%A0%2Fevil.example' },
  { family: 'whitespace: line separator', next: '%2F%E2%80%A8%2Fevil.example' },
  { family: 'whitespace: ideographic space', next: '%2Fsources%E3%80%80' },
  { family: 'backslash: slash then backslash', next: '%2F%5Cevil.example' },
  { family: 'backslash: backslash then tab', next: '%2F%5C%09evil.example' },
  { family: 'backslash: two leading backslashes', next: '%5C%5Cevil.example' },
  { family: 'backslash: slash then two backslashes', next: '%2F%5C%5Cevil.example' },
  { family: 'backslash: inside the path', next: '%2Fsources%5Cevil.example' },
  { family: 'backslash: unencoded after the slash', next: `/${BACKSLASH}evil.example` },
  { family: 'protocol-relative: two slashes', next: '%2F%2Fevil.example' },
  { family: 'protocol-relative: three slashes', next: '%2F%2F%2Fevil.example' },
  { family: 'protocol-relative: unencoded', next: '//evil.example' },
  { family: 'protocol-relative: with credentials', next: '%2F%2Fuser%40evil.example' },
  {
    family: 'protocol-relative: host equal to the parse base',
    next: '%2F%2Freturn-to.invalid%2Fx',
  },
  { family: 'protocol-relative: behind a dot segment', next: '%2F.%2F%2Fevil.example' },
  { family: 'protocol-relative: behind a parent segment', next: '%2F..%2F%2Fevil.example' },
  { family: 'encoded: double-encoded slashes', next: '%252F%252Fevil.example' },
  { family: 'encoded: double-encoded backslash', next: '%255Cevil.example' },
  { family: 'encoded: malformed escape', next: '%2Fdocuments%' },
  { family: 'encoded: overlong UTF-8 slash', next: '%C0%AF%2Fevil.example' },
  { family: 'encoded: lone surrogate', next: '%2F%ED%A0%80' },
  { family: 'scheme: javascript', next: 'javascript%3Aalert(1)' },
  { family: 'scheme: mixed-case javascript', next: 'JaVaScRiPt%3Aalert(1)' },
  { family: 'scheme: https with authority', next: 'https%3A%2F%2Fevil.example' },
  { family: 'scheme: https without slashes', next: 'https%3Aevil.example' },
  { family: 'scheme: data', next: 'data%3Atext%2Fhtml%2C%3Cscript%3Ealert(1)%3C%2Fscript%3E' },
  { family: 'not a path: bare host', next: 'evil.example' },
  { family: 'not a path: relative segment', next: 'sources' },
  { family: 'not a path: empty value', next: '' },
  { family: 'anonymous page: /login', next: '%2Flogin' },
  { family: 'anonymous page: /invite with a token', next: '%2Finvite%3Ftoken%3Dabc' },
  { family: 'anonymous page: /login with a fragment', next: '%2Flogin%23top' },
  { family: 'anonymous page: /login behind a dot segment', next: '%2F.%2Flogin' },
  { family: 'anonymous page: /login behind a parent segment', next: '%2Fsources%2F..%2Flogin' },
];

describe('resolveReturnTo', () => {
  it('falls back to / when there is no next parameter', () => {
    expect(resolveReturnTo('')).toBe('/');
  });

  it('honours a same-origin next path', () => {
    expect(resolveReturnTo('?next=%2Fdocuments%2Fabc%3Fskip%3D20')).toBe('/documents/abc?skip=20');
  });

  it('round-trips a path with a query and a fragment', () => {
    expect(resolveReturnTo('?next=%2Fsources%3Fview%3Dinventory%23row')).toBe(
      '/sources?view=inventory#row',
    );
  });

  it('reads next when it is not the first parameter', () => {
    expect(resolveReturnTo('?mode=x&next=%2Fsources')).toBe('/sources');
  });

  it('returns the parsed path rather than the raw value', () => {
    expect(resolveReturnTo('?next=%2Fsources%2F..%2Fanswers')).toBe('/answers');
  });

  it.each(REFUSED_NEXT_VALUES)('falls back to / for $family', ({ next }) => {
    expect(resolveReturnTo(`?next=${next}`)).toBe('/');
  });

  // A value that is still percent-encoded after the one decode is a literal path segment: it
  // stays on this origin, whatever it spells once decoded again.
  it.each(['%2F%2509%2Fevil.example', '%2F%255Cevil.example', '%2F%252Fevil.example'])(
    'keeps the still-encoded value %s on this origin',
    (next) => {
      const resolved = resolveReturnTo(`?next=${next}`);
      expect(resolved.startsWith('/')).toBe(true);
      expect(resolved.startsWith('//')).toBe(false);
      expect(new URL(resolved, 'https://app.example').origin).toBe('https://app.example');
    },
  );
});
