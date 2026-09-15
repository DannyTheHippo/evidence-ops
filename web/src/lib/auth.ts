import { ApiError, getMe, type Me } from '../api/client';

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

// Bumped by setSession/clearSession; a probe captures this before calling getMe(). A probe that
// settles after the generation moved on neither writes the cache nor notifies: it resolves through
// the current state instead — the primed user after setSession, the answer of the probe that
// follows clearSession — so no caller receives a result the newer state has already replaced.
let generation = 0;

const sessionListeners = new Set<(me: Me | null | undefined) => void>();

function notifySession(): void {
  for (const listener of sessionListeners) listener(cachedSession);
}

/** The cache's current value without triggering a probe — `undefined` while unprobed. */
export function getCachedSession(): Me | null | undefined {
  return cachedSession;
}

/** Registers `listener` to run on every `setSession`/`clearSession` and every probe that applies
 * its result; call with the same reference to `unsubscribeSession` on cleanup. */
export function subscribeSession(listener: (me: Me | null | undefined) => void): void {
  sessionListeners.add(listener);
}

export function unsubscribeSession(listener: (me: Me | null | undefined) => void): void {
  sessionListeners.delete(listener);
}

// Authorization gate: fails CLOSED per call. A definite 401 from GET /auth/me caches anonymous;
// every other rejection — a network error, a non-401 status — resolves to null for this call but
// leaves the cache unprobed, so the next `ensureSession()` re-probes rather than trusting a guess
// drawn from a transport failure. Concurrent callers (e.g. React StrictMode's double effect
// invocation) share one in-flight probe rather than each firing their own request.
export function ensureSession(): Promise<Me | null> {
  if (cachedSession !== undefined) {
    return Promise.resolve(cachedSession);
  }
  if (inFlightProbe) {
    return inFlightProbe;
  }

  const probeGeneration = generation;
  const probe: Promise<Me | null> = getMe()
    .then((me) => {
      if (generation !== probeGeneration) return ensureSession();
      cachedSession = me;
      notifySession();
      return me;
    })
    .catch((err) => {
      if (generation !== probeGeneration) return ensureSession();
      if (err instanceof ApiError && err.status === 401) {
        cachedSession = null;
        notifySession();
      }
      return null;
    })
    .finally(() => {
      // A newer probe may already hold the slot; only this probe's own entry is released.
      if (inFlightProbe === probe) inFlightProbe = null;
    });
  inFlightProbe = probe;

  return probe;
}

// Login already knows who the server just authenticated — priming the cache here skips a
// redundant round trip to /auth/me on the next protected-route mount, and (since the cache
// persists across calls) prevents a stale cached `anon` from a pre-login probe surviving login.
export function setSession(me: Me): void {
  cachedSession = me;
  inFlightProbe = null;
  generation++;
  notifySession();
}

export function clearSession(): void {
  cachedSession = undefined;
  inFlightProbe = null;
  generation++;
  notifySession();
}
