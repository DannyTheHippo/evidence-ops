/*
 * Hand-rolled `Cookie:` header parser (no `cookie-parser` dependency). Parses attacker-controlled
 * input on every request, so it fails OPEN on a malformed segment — skip it, never throw — and
 * lets the auth guard's own rejection handle a request that ends up with no usable cookie.
 */
export const parseCookieHeader = (header?: string): Record<string, string> => {
  const cookies: Record<string, string> = {};
  // Names seen so far, tracked independently of `cookies` (which only holds successfully decoded
  // values) — a name that appeared once with a malformed value still counts as "seen" for
  // duplicate detection below.
  const seen = new Set<string>();
  if (!header) {
    return cookies;
  }

  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    if (seen.has(name)) {
      // Fail CLOSED on a duplicate name: RFC 6265 §5.4 sorts a longer-`Path` cookie first, so
      // e.g. a subdomain-planted `Domain=.example.com; Path=/api/v1` copy of the session cookie
      // arrives before the legitimate `Path=/` one. Picking either value would be a confident
      // accept of a possibly-attacker identity, so an ambiguous name is excluded entirely rather
      // than resolved by position. Honest trade: this converts a session-fixation vector into an
      // availability one — someone who can plant a duplicate can deny the session — which is the
      // correct direction for an integrity gate.
      delete cookies[name];
      continue;
    }
    seen.add(name);

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
  }

  return cookies;
};
