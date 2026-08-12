import { getMe, type Me } from '../api/client';

// One-time migration: every browser that used the app before the cookie switch (see git history,
// pre-a7d7ea9 `web/src/lib/auth.ts`) may still hold a valid JWT under this key, readable by any
// XSS until it expires on its own. The SPA no longer reads or writes it, so nothing else will
// ever clear it — this is the only place that does.
localStorage.removeItem('eo_token');

// The SPA holds no credential of its own — no localStorage token — so it cannot answer "am I
// logged in?" without asking the server. `undefined` means "not yet probed since the last
// invalidation, including a fresh logout — `clearSession()` resets to this, not to a confirmed
// `null`, so the next check re-verifies against the server rather than trusting a local flag";
// `null` means a probe confirmed there is no session; a `Me` means a probe (or a fresh login)
// confirmed there is. Only `clearSession()` (logout) or `setSession()` (login) invalidates the
// cache — a 401 elsewhere in the app does a full-page navigation (`window.location.assign` in
// api/client.ts), which wipes this module along with everything else.
let cachedSession: Me | null | undefined;
let inFlightProbe: Promise<Me | null> | null = null;

// Authorization gate: fails CLOSED. Anything other than a definite 200 from GET /auth/me — a
// 401, a network error, any thrown ApiError — resolves to null here, never to a stale "probably
// still logged in" guess. Concurrent callers (e.g. React StrictMode's double effect invocation)
// share one in-flight probe rather than each firing their own request.
export function ensureSession(): Promise<Me | null> {
  if (cachedSession !== undefined) {
    return Promise.resolve(cachedSession);
  }
  if (inFlightProbe) {
    return inFlightProbe;
  }

  inFlightProbe = getMe()
    .then((me) => {
      cachedSession = me;
      return me;
    })
    .catch(() => {
      cachedSession = null;
      return null;
    })
    .finally(() => {
      inFlightProbe = null;
    });

  return inFlightProbe;
}

// Login already knows who the server just authenticated — priming the cache here skips a
// redundant round trip to /auth/me on the next protected-route mount, and (since the cache
// persists across calls) prevents a stale cached `anon` from a pre-login probe surviving login.
export function setSession(me: Me): void {
  cachedSession = me;
  inFlightProbe = null;
}

export function clearSession(): void {
  cachedSession = undefined;
  inFlightProbe = null;
}
