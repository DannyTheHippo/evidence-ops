import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatest } from './use-latest';

/**
 * Holds a text filter's draft and applies it `delayMs` after the last change. `setDraft` stores
 * the draft and restarts the wait; `flush` applies the latest draft at once and drops the pending
 * wait; `cancel` drops the pending wait without applying; `reset` sets the draft to `value` without
 * applying it, for a caller that is about to write that same value to `applied` itself. Unmount
 * cancels.
 *
 * The draft lives in a ref as well as in state. `setDraft` writes the ref synchronously, so a
 * `flush` called in the same handler as `setDraft` applies that value rather than the draft of the
 * last render. `flush`, `cancel` and `reset` keep a stable identity; `setDraft` is stable while
 * `delayMs` is.
 *
 * The hook records the value it last sent — in the timer callback, in `flush`, and in `reset` —
 * because react-router wraps a URL write in a transition that can commit a whole render later.
 * When `applied` changes to that recorded value, this is the hook's own write echoing back, and a
 * newer draft and its timer survive untouched. When `applied` changes to anything else — a Clear,
 * a chip removal, back/forward navigation, another control — the draft re-syncs to it and the
 * pending wait is cancelled; that new value is recorded too, so a later echo of an older send this
 * hook made is never mistaken for the external change that just superseded it.
 *
 * The hook always calls `apply` with the draft and does no validation or comparison: rejecting an
 * invalid value, and skipping a write when the value equals `applied`, belong to the caller.
 * `apply` is read at call time, so it need not be stable.
 */
export function useDebouncedApply(
  applied: string,
  apply: (value: string) => void,
  delayMs = 300,
): {
  draft: string;
  setDraft: (value: string) => void;
  flush: () => void;
  cancel: () => void;
  reset: (value: string) => void;
} {
  const [draft, setDraftState] = useState(applied);
  const [previousApplied, setPreviousApplied] = useState(applied);
  // The value this hook itself last sent, kept in state for the render-phase check below —
  // reading a ref during render is forbidden — and mirrored in a ref for the effect. `null` at
  // mount: nothing has been sent yet, so the initial `applied` can never read as an echo.
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const lastAppliedRef = useRef<string | null>(null);
  const latestApply = useLatest(apply);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftRef = useRef(applied);

  if (applied !== previousApplied) {
    setPreviousApplied(applied);
    if (applied !== lastApplied) {
      setDraftState(applied);
      setLastApplied(applied);
    }
  }

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  // Mirrors the render-phase branch above in a ref this effect can read without listing it as a
  // dependency. Skipped on the hook's own echo, so the draft ref and a timer armed after the send
  // it is waiting on survive the round trip.
  useEffect(() => {
    if (applied === lastAppliedRef.current) return;
    lastAppliedRef.current = applied;
    draftRef.current = applied;
    cancel();
  }, [applied, cancel]);

  // Unmount-only: tying this to `[applied]` would cancel a live draft's timer on every echo too.
  useEffect(() => cancel, [cancel]);

  const setDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraftState(value);
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        lastAppliedRef.current = value;
        setLastApplied(value);
        latestApply.current(value);
      }, delayMs);
    },
    [cancel, delayMs, latestApply],
  );

  const flush = useCallback(() => {
    cancel();
    const value = draftRef.current;
    lastAppliedRef.current = value;
    setLastApplied(value);
    latestApply.current(value);
  }, [cancel, latestApply]);

  const reset = useCallback(
    (value: string) => {
      cancel();
      draftRef.current = value;
      setDraftState(value);
      lastAppliedRef.current = value;
      setLastApplied(value);
    },
    [cancel],
  );

  return { draft, setDraft, flush, cancel, reset };
}
