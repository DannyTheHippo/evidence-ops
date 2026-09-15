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

  it('leaves the cache unprobed after a transport failure so the next call re-probes', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession } = await import('./auth');

    await expect(ensureSession()).resolves.toBeNull();
    await expect(ensureSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches anonymous only for a definite 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession } = await import('./auth');

    await expect(ensureSession()).resolves.toBeNull();
    await expect(ensureSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a probe that settles after setSession primed the cache', async () => {
    let rejectFetch: (err: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession, setSession } = await import('./auth');

    const firstProbe = ensureSession();
    setSession(me);
    rejectFetch(new TypeError('Failed to fetch'));

    await expect(firstProbe).resolves.toEqual(me);
    await expect(ensureSession()).resolves.toEqual(me);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a probe superseded by setSession to the primed user even when it settles 401', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { ensureSession, getCachedSession, setSession } = await import('./auth');

    const firstProbe = ensureSession();
    setSession(me);
    resolveFetch(jsonResponse({ message: 'Unauthorized' }, 401));

    await expect(firstProbe).resolves.toEqual(me);
    expect(getCachedSession()).toEqual(me);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the probe started after clearSession shared once the superseded probe settles', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { clearSession, ensureSession } = await import('./auth');

    const firstProbe = ensureSession();
    clearSession();
    const secondProbe = ensureSession();
    resolvers[0](jsonResponse({ message: 'Unauthorized' }, 401));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const thirdProbe = ensureSession();

    expect(thirdProbe).toBe(secondProbe);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvers[1](jsonResponse(me));
    await expect(firstProbe).resolves.toEqual(me);
    await expect(thirdProbe).resolves.toEqual(me);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers on setSession and clearSession', async () => {
    const { clearSession, setSession, subscribeSession, unsubscribeSession } =
      await import('./auth');
    const listener = vi.fn();
    subscribeSession(listener);

    setSession(me);
    clearSession();
    unsubscribeSession(listener);
    setSession(me);

    expect(listener).toHaveBeenNthCalledWith(1, me);
    expect(listener).toHaveBeenNthCalledWith(2, undefined);
    expect(listener).toHaveBeenCalledTimes(2);
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
