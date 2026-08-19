import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransportError, getMe, listSources, uploadDocument } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Mimics `fetch`'s own contract for an aborted request: it never settles on its own, only in
// reaction to the signal the caller passed in — same as the browser rejecting with an AbortError
// once a real network request is cancelled.
function abortableFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
}

const realLocation: Location = window.location;

// jsdom's `location.assign` is a non-configurable property `vi.spyOn` cannot redefine — swapping
// the whole `window.location` for a minimal stub is the only way to observe the call.
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign },
  });
  return assign;
}

describe('client transport handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('turns a dropped-connection rejection into a typed transport error with one human message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await getMe().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('times out a hung request into the same typed transport error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(abortableFetch()));

    const pending = getMe();
    const assertion = expect(pending).rejects.toBeInstanceOf(TransportError);
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
  });

  it('propagates a rejection it does not recognize instead of masking it as a transport failure', async () => {
    const bug = new Error('JSON.parse blew up for an unrelated reason');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(bug));

    await expect(getMe()).rejects.toBe(bug);
  });

  it('redirects to /login on a 401 for a non-auth path', async () => {
    const assign = stubLocationAssign();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    await expect(listSources()).rejects.toMatchObject({ status: 401 });

    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('exempts /auth/* paths from the 401 redirect', async () => {
    const assign = stubLocationAssign();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401)),
    );

    await expect(getMe()).rejects.toMatchObject({ status: 401 });

    expect(assign).not.toHaveBeenCalled();
  });

  it('omits Content-Type on a FormData body, letting the browser set its own multipart boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'doc-1',
        title: 'rent-roll.pdf',
        sourceKind: 'pdf',
        mimeType: 'application/pdf',
        sourceClass: 'unclassified',
        currentVersion: {
          id: 'v1',
          versionNumber: 1,
          sha256: 'abc',
          sizeBytes: 1,
          ingestionStatus: 'pending',
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadDocument(new File(['a'], 'rent-roll.pdf', { type: 'application/pdf' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('resolves to undefined on a 204, never attempting to parse an empty body as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(listSources()).resolves.toBeUndefined();
  });
});
