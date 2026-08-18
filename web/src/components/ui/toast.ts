export type ToastKind = 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type ToastListener = (toasts: Toast[]) => void;

// A toast carries the result of an action whose origin may have scrolled away, so it lives in
// module scope rather than component state, matching auth.ts's session cache and
// use-event-stream.ts's stream-status idiom: module-scope variable plus functions, no class, no
// context provider.
let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<ToastListener>();

// A success toast is a low-stakes confirmation and is safe to lose after a glance; an error toast
// describes something the reader needs to act on, so only the dismiss control removes it.
const SUCCESS_AUTO_DISMISS_MS = 5000;

function publish(): void {
  for (const listener of listeners) listener(toasts);
}

export function subscribeToasts(listener: ToastListener): void {
  listeners.add(listener);
}

export function unsubscribeToasts(listener: ToastListener): void {
  listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  publish();
}

export function notify(kind: ToastKind, message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  publish();
  if (kind === 'success') {
    // A pending timer firing after the toast was already dismissed (by hand, or by clearToasts())
    // is a harmless no-op filter in dismissToast — no handle to track or cancel.
    setTimeout(() => dismissToast(id), SUCCESS_AUTO_DISMISS_MS);
  }
}

// Test-only reset of the module-scope store, mirroring clearSession() in auth.ts.
export function clearToasts(): void {
  toasts = [];
  nextId = 0;
  publish();
}
