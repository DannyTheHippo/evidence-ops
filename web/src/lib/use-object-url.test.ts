import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useObjectUrl } from './use-object-url';

// jsdom implements neither method — stubbing the real `URL` class (rather than a bare object)
// keeps every other static/instance behaviour (URLSearchParams parsing elsewhere in a render
// tree, `new URL(...)`) working exactly as it does outside the test.
function stubObjectUrl(): {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const createObjectURL = vi.fn(() => `blob:mock-${(counter += 1)}`);
  const revokeObjectURL = vi.fn();
  class StubUrl extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', StubUrl);
  return { createObjectURL, revokeObjectURL };
}

describe('useObjectUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never fetches when key is null', () => {
    stubObjectUrl();
    const fetchBlob = vi.fn();

    const { result } = renderHook(() => useObjectUrl<string>(null, fetchBlob));

    expect(fetchBlob).not.toHaveBeenCalled();
    expect(result.current).toEqual({ url: null, error: null });
  });

  it('fetches the blob for key and exposes the created object URL', async () => {
    const { createObjectURL } = stubObjectUrl();
    const blob = new Blob(['pdf-bytes']);
    const fetchBlob = vi.fn().mockResolvedValue(blob);

    const { result } = renderHook(() => useObjectUrl('version-1', fetchBlob));

    await waitFor(() => expect(result.current.url).toBe('blob:mock-1'));

    expect(fetchBlob).toHaveBeenCalledWith('version-1');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a rejection as a human message instead of leaving the pane blank', async () => {
    stubObjectUrl();
    const fetchBlob = vi.fn().mockRejectedValue(new Error('Could not reach the server.'));

    const { result } = renderHook(() => useObjectUrl('version-1', fetchBlob));

    await waitFor(() => expect(result.current.error).toBe('Could not reach the server.'));
    expect(result.current.url).toBeNull();
  });

  it('revokes the previous object URL when key changes, and the current one on unmount', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    const fetchBlob = vi.fn((key: string) => Promise.resolve(new Blob([key])));

    const { result, rerender, unmount } = renderHook(
      ({ key }: { key: string }) => useObjectUrl(key, fetchBlob),
      { initialProps: { key: 'v1' } },
    );

    await waitFor(() => expect(result.current.url).toBe('blob:mock-1'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    rerender({ key: 'v2' });

    await waitFor(() => expect(result.current.url).toBe('blob:mock-2'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
  });
});
