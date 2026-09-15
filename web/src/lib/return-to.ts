// The two pages an anonymous visitor can already reach — sending either back to itself as a
// return target would loop.
const ANONYMOUS_PATHS = new Set(['/login', '/invite']);

// A reserved origin that never resolves: a `next` value that still carries this origin once parsed
// is a path on whichever origin serves the app.
const PARSE_BASE = 'http://return-to.invalid';

// Whitespace, control characters and backslashes. A browser strips tab, LF and CR anywhere in a URL
// and reads `\` as `/`, so each of them can turn a value that looks like a local path into a
// cross-origin one; a genuine return target never carries any of them once decoded.
const UNSAFE_CHARACTERS = /[\s\p{Cc}\\]/u;

/** Sign-in URL that returns the visitor to `location` afterwards; the root and the two anonymous
 * pages get plain `/login`. */
export function loginHrefFor(location: { pathname: string; search: string }): string {
  if (location.pathname === '/' || ANONYMOUS_PATHS.has(location.pathname)) return '/login';
  const target = `${location.pathname}${location.search}`;
  return `/login?next=${encodeURIComponent(target)}`;
}

/** Where a successful sign-in lands: the `next` query value when it parses as a path on this
 * origin, returned as the parsed `pathname + search + hash` and never as the raw string, else `/`.
 * Fails CLOSED: a value that does not decode, does not start with a single `/`, carries whitespace,
 * a control character or a backslash, does not parse, parses to another origin, resolves to a `//`
 * path, or names `/login` or `/invite` lands on `/`. */
export function resolveReturnTo(search: string): string {
  const match = /(?:^|[?&])next=([^&]*)/.exec(search);
  if (!match) return '/';

  let next: string;
  try {
    next = decodeURIComponent(match[1]);
  } catch {
    return '/';
  }

  if (!next.startsWith('/') || next.startsWith('//') || UNSAFE_CHARACTERS.test(next)) return '/';

  let url: URL;
  try {
    url = new URL(next, PARSE_BASE);
  } catch {
    return '/';
  }

  // Dot segments can collapse into a leading `//`, which a link or navigation reads as a host.
  if (url.origin !== PARSE_BASE || url.pathname.startsWith('//')) return '/';
  if (ANONYMOUS_PATHS.has(url.pathname)) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
