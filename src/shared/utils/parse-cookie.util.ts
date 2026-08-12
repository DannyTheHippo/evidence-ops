/**
 * Parses a `Cookie:` request header into a name/value map, without a `cookie-parser` dependency.
 *
 * The input is attacker-controlled on every request, so a malformed segment fails OPEN: it is
 * skipped and parsing continues, never throwing. A request that ends up with no usable cookie is
 * rejected by the auth guard, which is the component that owns that decision.
 *
 * @param header Raw `Cookie:` header value; `undefined` yields an empty map.
 * @returns Decoded cookie values by name. A name appearing more than once is absent entirely.
 */
export const parseCookieHeader = (header?: string): Record<string, string> => {
  const cookies: Record<string, string> = {};
  /**
   * Names encountered so far, tracked separately from `cookies` because `cookies` holds only
   * successfully decoded values. A name whose value failed to decode still counts as seen, so it
   * cannot be reintroduced by a later duplicate.
   */
  const seen = new Set<string>();
  if (!header) {
    return cookies;
  }

  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }

    /** A separator at index 0 means an empty name, which is not a usable cookie. */
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    /**
     * Non-empty by construction: `trimmed` has no leading whitespace, and `separatorIndex > 0`
     * means this slice retains `trimmed[0]`, which trimming cannot remove. No emptiness check
     * follows because no input can reach one.
     */
    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (seen.has(name)) {
      /**
       * A duplicate name fails CLOSED. RFC 6265 §5.4 orders a longer-`Path` cookie first, so a
       * subdomain-planted `Domain=.example.com; Path=/api/v1` copy of the session cookie arrives
       * ahead of the legitimate `Path=/` one. Choosing either value would accept a possibly
       * attacker-supplied identity, so an ambiguous name is dropped rather than resolved by
       * position. This trades a session-fixation vector for an availability one — anyone able to
       * plant a duplicate can deny the session — which is the correct direction for an integrity
       * gate.
       */
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
