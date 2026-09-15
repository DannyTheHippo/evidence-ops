import { renderHook, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAbortableEffect, useLatest } from './use-latest';

// Resolves on demand, so a test can control which of two concurrent runs settles first.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useLatest', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the latest value from a timer set up once, without listing value as a dependency', () => {
    vi.useFakeTimers();
    const effectRuns = vi.fn();
    const seen: string[] = [];

    const { rerender } = renderHook(
      ({ value }: { value: string }) => {
        const latest = useLatest(value);
        useEffect(() => {
          effectRuns();
          const id = setTimeout(() => seen.push(latest.current), 100);
          return () => clearTimeout(id);
          // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, the point under test
        }, []);
      },
      { initialProps: { value: 'first' } },
    );

    rerender({ value: 'second' });
    vi.advanceTimersByTime(100);

    expect(effectRuns).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['second']);
  });
});

describe('useAbortableEffect', () => {
  it('drops the response of a superseded run and renders the newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetchFor = vi.fn((id: string) => (id === 'a' ? first.promise : second.promise));

    function useProbe(id: string): string | null {
      const [value, setValue] = useState<string | null>(null);
      useAbortableEffect(
        async (isCurrent) => {
          const response = await fetchFor(id);
          if (isCurrent()) setValue(response);
        },
        [id],
      );
      return value;
    }

    const { result, rerender } = renderHook(({ id }: { id: string }) => useProbe(id), {
      initialProps: { id: 'a' },
    });

    rerender({ id: 'b' });

    // The newer run settles first; the superseded run settles after and must not overwrite it.
    second.resolve('from-b');
    await waitFor(() => expect(result.current).toBe('from-b'));

    first.resolve('from-a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current).toBe('from-b');
  });
});
