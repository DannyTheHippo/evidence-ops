import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCopyToClipboard } from './use-copy-to-clipboard';

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('useCopyToClipboard', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    vi.useRealTimers();
  });

  it('reports an error rather than throwing when navigator.clipboard is absent', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => result.current.copy('hello'));

    expect(result.current.copied).toBe(false);
    expect(result.current.error).toBe(true);
  });

  it('reports an error rather than throwing when writeText rejects', async () => {
    stubClipboard(() => Promise.reject(new Error('permission denied')));
    const { result } = renderHook(() => useCopyToClipboard());

    act(() => result.current.copy('hello'));

    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.copied).toBe(false);
  });

  it('flips copied true on a successful write, then clears it on a timer', async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('hello');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.copied).toBe(true);
    expect(result.current.error).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.copied).toBe(false);
  });

  it('still reports success under StrictMode, which mounts every component twice', async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopyToClipboard(), { wrapper: StrictMode });

    await act(async () => {
      result.current.copy('hello');
      await vi.advanceTimersByTimeAsync(0);
    });

    // The app is wrapped in StrictMode in main.tsx, so this is the real path, not a synthetic one.
    expect(result.current.copied).toBe(true);
    expect(result.current.error).toBe(false);
  });

  it('clears the reset timer on unmount without setting state on the unmounted instance', async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy('hello');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.copied).toBe(true);

    unmount();

    // No React "state update on an unmounted component" warning is the assertion here — the
    // timer fires after unmount and must find the hook already guarding against it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
  });
});
