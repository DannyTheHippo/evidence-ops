import { useEffect, useState } from 'react';
import { IconX } from '../icons';
import IconButton from './IconButton';
import { dismissToast, getToasts, subscribeToasts, unsubscribeToasts, type Toast } from './toast';

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
 * store, not props. The wrapper carries `aria-live="polite"` and stays mounted regardless of queue
 * state, matching `ConnectionStatus.tsx` — a live region announced at the same instant as its
 * first content is routinely missed by screen readers. Success toasts sit in `role="status"` and
 * auto-dismiss (handled by the store, and unaffected by whether the toast is currently visible);
 * error toasts sit in `role="alert"` and only the dismiss control removes them, since the store
 * never auto-dismisses an error. */
export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>(getToasts);

  useEffect(() => {
    subscribeToasts(setToasts);
    return () => unsubscribeToasts(setToasts);
  }, []);

  return (
    <div className="toast-stack" aria-live="polite">
      {visibleToasts(toasts).map((toast) =>
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
          <div key={toast.id} className="toast toast--success" role="status" aria-live="polite">
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
    </div>
  );
}
