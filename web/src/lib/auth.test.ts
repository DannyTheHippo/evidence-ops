import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const me = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

describe('auth session cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shares one in-flight probe across concurrent callers (single-flight)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(me));
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession } = await import('./auth');

    const [first, second] = await Promise.all([ensureSession(), ensureSession()]);

    expect(first).toEqual(me);
    expect(second).toEqual(me);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to null — never a stale "still logged in" guess — when the probe fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession } = await import('./auth');

    await expect(ensureSession()).resolves.toBeNull();
  });

  it('primes the cache on login so the next ensureSession() skips the network round trip', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(me));
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession, setSession } = await import('./auth');

    setSession(me);
    const result = await ensureSession();

    expect(result).toEqual(me);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates the cache on logout, forcing a fresh probe on the next call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(me));
    vi.stubGlobal('fetch', fetchMock);
    const { clearSession, ensureSession, setSession } = await import('./auth');

    setSession(me);
    clearSession();
    await ensureSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Pre-cookie-switch clients stored the bearer token under this key (see git history, the
  // `web/src/lib/auth.ts` shape before commit a7d7ea9). Nothing in the SPA reads or writes it
  // anymore, so it would otherwise sit in localStorage, readable by any XSS, until it expires on
  // its own — the module has to clear it itself.
  it('removes the legacy eo_token key from localStorage on load', async () => {
    localStorage.setItem('eo_token', 'stale-bearer-token');

    await import('./auth');

    expect(localStorage.getItem('eo_token')).toBeNull();
  });
});
