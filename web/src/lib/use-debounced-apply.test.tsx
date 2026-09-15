import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedApply } from './use-debounced-apply';

function renderDebounced(initialApplied = '') {
  const apply = vi.fn<(value: string) => void>();
  const hook = renderHook(({ applied }: { applied: string }) => useDebouncedApply(applied, apply), {
    initialProps: { applied: initialApplied },
  });
  return { apply, ...hook };
}

describe('useDebouncedApply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies once, 300 ms after the last change', () => {
    const { apply, result } = renderDebounced();

    act(() => result.current.setDraft('acme'));
    expect(result.current.draft).toBe('acme');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(apply).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('acme');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('restarts the wait on a superseding change and applies only the last value', () => {
    const { apply, result } = renderDebounced();

    act(() => result.current.setDraft('ac'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.setDraft('acme'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(apply).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('acme');
  });

  it('applies the draft at once on flush, and nothing fires later', () => {
    const { apply, result } = renderDebounced();

    act(() => result.current.setDraft('acme'));
    act(() => result.current.flush());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('acme');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('flushes the value set earlier in the same handler, not the rendered draft', () => {
    const { apply, result } = renderDebounced('acme');

    act(() => {
      result.current.setDraft('');
      result.current.flush();
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('drops the pending apply on cancel', () => {
    const { apply, result } = renderDebounced();

    act(() => result.current.setDraft('acme'));
    act(() => result.current.cancel());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(apply).not.toHaveBeenCalled();
    expect(result.current.draft).toBe('acme');
  });

  it('drops the pending apply on unmount', () => {
    const { apply, result, unmount } = renderDebounced();

    act(() => result.current.setDraft('acme'));
    unmount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(apply).not.toHaveBeenCalled();
  });

  it('re-syncs the draft to an external applied change and drops the pending apply', () => {
    const { apply, result, rerender } = renderDebounced('acme');
    expect(result.current.draft).toBe('acme');

    act(() => result.current.setDraft('acme-typed'));
    rerender({ applied: '' });

    expect(result.current.draft).toBe('');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('flushes the re-synced applied value after an external applied change', () => {
    const { apply, result, rerender } = renderDebounced('acme');

    act(() => result.current.setDraft('acme-typed'));
    rerender({ applied: '' });
    act(() => result.current.flush());

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('');
  });

  it('keeps a newer draft and its timer when its own echo lands after a delayed re-render', () => {
    const { apply, result, rerender } = renderDebounced('');

    act(() => result.current.setDraft('acme'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('acme');

    // A keystroke lands before the router's transition carrying this apply's echo commits.
    act(() => result.current.setDraft('acme c'));

    // The echo commits a whole render later, carrying the value this hook itself just sent.
    rerender({ applied: 'acme' });
    expect(result.current.draft).toBe('acme c');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith('acme c');
  });

  it('records an external change too, so a later echo of an older send is not mistaken for it', () => {
    const { apply, result, rerender } = renderDebounced('');

    act(() => result.current.setDraft('acme'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ applied: 'acme' }); // the send from above echoes back

    rerender({ applied: '' }); // an external Clear, unrelated to this hook's own send
    expect(result.current.draft).toBe('');

    act(() => result.current.setDraft('x'));
    rerender({ applied: 'acme' }); // back navigation lands on the same value this hook sent earlier

    expect(result.current.draft).toBe('acme');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('resets the draft and cancels the pending apply without touching applied', () => {
    const { apply, result } = renderDebounced('acme');

    act(() => result.current.setDraft('acme-typed'));
    act(() => result.current.reset(''));

    expect(result.current.draft).toBe('');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('a reset value is recorded, so its own echo does not clobber a keystroke typed after it', () => {
    const { apply, result, rerender } = renderDebounced('acme');

    act(() => result.current.reset(''));
    act(() => result.current.setDraft('y'));

    // The reset value's echo lands after the keystroke, exactly like a debounced apply's would.
    rerender({ applied: '' });
    expect(result.current.draft).toBe('y');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('y');
  });

  it('calls the latest apply without it being stable', () => {
    const first = vi.fn<(value: string) => void>();
    const second = vi.fn<(value: string) => void>();
    const { result, rerender } = renderHook(
      ({ apply }: { apply: (value: string) => void }) => useDebouncedApply('', apply),
      { initialProps: { apply: first } },
    );

    act(() => result.current.setDraft('acme'));
    rerender({ apply: second });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('acme');
  });
});
