/*
 * Hand-rolled `Cookie:` header parser (no `cookie-parser` dependency). Parses attacker-controlled
 * input on every request, so it fails OPEN on a malformed segment — skip it, never throw — and
 * lets the auth guard's own rejection handle a request that ends up with no usable cookie.
 */
export const parseCookieHeader = (header?: string): Record<string, string> => {
  const cookies: Record<string, string> = {};
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
    if (!name || name in cookies) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
  }

  return cookies;
};
