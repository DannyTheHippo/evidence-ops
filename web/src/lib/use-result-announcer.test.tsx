import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAnnouncements, subscribeAnnouncements } from './announce';
import { useResultAnnouncer } from './use-result-announcer';

describe('useResultAnnouncer', () => {
  afterEach(() => {
    clearAnnouncements();
  });

  it('records the first call silently', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    const { result } = renderHook(() => useResultAnnouncer());

    result.current('{"status":""}', '12 runs');

    expect(listener).not.toHaveBeenCalled();
  });

  it('stays silent for a later call with the recorded key', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    const { result } = renderHook(() => useResultAnnouncer());

    result.current('{"status":""}', '12 runs');
    result.current('{"status":""}', '12 runs');

    expect(listener).not.toHaveBeenCalled();
  });

  it('announces a changed key exactly once', () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);
    const { result } = renderHook(() => useResultAnnouncer());

    result.current('{"status":""}', '12 runs');
    result.current('{"status":"failed"}', '3 runs');
    result.current('{"status":"failed"}', '3 runs');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('3 runs');
  });

  it('returns the same callback across renders', () => {
    const { result, rerender } = renderHook(() => useResultAnnouncer());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
