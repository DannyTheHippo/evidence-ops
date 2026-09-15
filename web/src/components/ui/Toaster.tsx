import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { IconX } from '../icons';
import IconButton from './IconButton';
import {
  dismissToast,
  getToasts,
  pauseToasts,
  resumeToasts,
  subscribeToasts,
  unsubscribeToasts,
  type Toast,
} from './toast';

const VISIBLE_CAP = 3;

/** Selects the toasts the stack renders: newest-first errors, then newest-first successes, capped
 * at `VISIBLE_CAP` overall. The store keeps every toast regardless — a toast dropped from this
 * view still exists, still counts toward its own auto-dismiss timer, and reappears once a visible
 * slot frees up. */
function visibleToasts(toasts: Toast[]): Toast[] {
  const byNewestFirst = toasts.slice().reverse();
  const errors = byNewestFirst.filter((toast) => toast.kind === 'error');
  const successes = byNewestFirst.filter((toast) => toast.kind === 'success');
  return [...errors, ...successes].slice(0, VISIBLE_CAP);
}

/** Renders the module-scope toast queue from `toast.ts`. Mounts once in the app shell — every
 * `notify()` call anywhere in the app reaches this one instance through the subscribe/publish
 * store, not props. The wrapper carries the stack's only `aria-live="polite"` and stays mounted
 * regardless of queue state, matching `ConnectionStatus.tsx` — a live region announced at the same
 * instant as its first content is routinely missed by screen readers, and a second nested
 * `aria-live` on a toast double-announces it. Success toasts sit in `role="status"` and
 * auto-dismiss (handled by the store, and unaffected by whether the toast is currently visible);
 * error toasts sit in `role="alert"` and only the dismiss control removes them, since the store
 * never auto-dismisses an error. Pointer hover or focus anywhere in the stack freezes every
 * counting-down success toast at its remaining time via `pauseToasts()`/`resumeToasts()`. */
export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>(getToasts);
  const stackRef = useRef<HTMLDivElement | null>(null);
  // Whichever element held focus just before it moved into the stack, so a toast the timer
  // removes while it holds focus — see the effect below — has somewhere to send focus back to
  // once the stack itself has nothing left.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const hoveringRef = useRef(false);
  const focusWithinRef = useRef(false);

  useEffect(() => {
    subscribeToasts(setToasts);
    return () => unsubscribeToasts(setToasts);
  }, []);

  // A toast the timer removes while it holds focus must not strand the reader on a detached
  // node: move focus to the next visible toast's dismiss control, or back to whatever held focus
  // before the stack did.
  useEffect(() => {
    if (!focusWithinRef.current) return;
    if (stackRef.current?.contains(document.activeElement)) return;
    const nextDismiss = stackRef.current?.querySelector<HTMLElement>('.toast button');
    if (nextDismiss) {
      nextDismiss.focus();
      return;
    }
    focusWithinRef.current = false;
    restoreFocusRef.current?.focus();
  }, [toasts]);

  // Hover and focus-within pause independently but share one paused flag in the store, so a
  // release of either only resumes once neither is still holding it.
  const syncPause = () => {
    if (hoveringRef.current || focusWithinRef.current) {
      pauseToasts();
    } else {
      resumeToasts();
    }
  };

  const handleMouseEnter = () => {
    hoveringRef.current = true;
    syncPause();
  };

  const handleMouseLeave = () => {
    hoveringRef.current = false;
    syncPause();
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!focusWithinRef.current) {
      restoreFocusRef.current =
        event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    }
    focusWithinRef.current = true;
    syncPause();
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (stackRef.current?.contains(event.relatedTarget)) return;
    focusWithinRef.current = false;
    syncPause();
  };

  const visible = visibleToasts(toasts);
  const hiddenCount = toasts.length - visible.length;

  return (
    <div
      ref={stackRef}
      className="toast-stack"
      aria-live="polite"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {visible.map((toast) =>
        toast.kind === 'error' ? (
          <div key={toast.id} className="toast toast--error" role="alert">
            <p className="toast-message">{toast.message}</p>
            <IconButton
              icon={<IconX />}
              aria-label="Dismiss"
              variant="ghost"
              size="sm"
              onClick={() => dismissToast(toast.id)}
            />
          </div>
        ) : (
          <div key={toast.id} className="toast toast--success" role="status">
            <p className="toast-message">{toast.message}</p>
            <IconButton
              icon={<IconX />}
              aria-label="Dismiss"
              variant="ghost"
              size="sm"
              onClick={() => dismissToast(toast.id)}
            />
          </div>
        ),
      )}
      {hiddenCount > 0 && <p className="toast-stack-more">{hiddenCount} more</p>}
    </div>
  );
}
