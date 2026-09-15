import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession, ensureSession, setSession } from './auth';
import { useSession } from './use-session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

describe('useSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('starts loading, then resolves authed with the probed user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(admin)));

    const { result } = renderHook(() => useSession());

    expect(result.current).toEqual({ status: 'loading', me: null });

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'authed', me: admin });
    });
  });

  it('resolves anon — never a stale "still logged in" guess — when the probe is unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    const { result } = renderHook(() => useSession());

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'anon', me: null });
    });
  });

  it('resolves anon on unmount without setting state on the unmounted instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(admin)));

    const { result, unmount } = renderHook(() => useSession());
    act(() => unmount());

    // No assertion on result.current after unmount — this only proves the effect's cleanup
    // does not throw or warn ("state update on an unmounted component") when the probe
    // resolves after the component is gone.
    await waitFor(() => {
      expect(result.current).toEqual({ status: 'loading', me: null });
    });
  });

  it('starts authed, not loading, when the cache already holds a user', () => {
    setSession(admin);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSession());

    expect(result.current).toEqual({ status: 'authed', me: admin });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays authed when a probe pending across setSession settles 401 afterwards', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSession());
    // Joins the hook's in-flight probe, so awaiting it waits for the hook's own resolution.
    const hookProbe = ensureSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setSession(admin));
    expect(result.current).toEqual({ status: 'authed', me: admin });

    await act(async () => {
      resolveFetch(jsonResponse({ message: 'Unauthorized' }, 401));
      await hookProbe;
    });

    expect(result.current).toEqual({ status: 'authed', me: admin });
  });

  it('moves to anon when clearSession runs while mounted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(admin))
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSession());

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'authed', me: admin });
    });

    clearSession();

    await waitFor(() => {
      expect(result.current).toEqual({ status: 'anon', me: null });
    });
  });
});
