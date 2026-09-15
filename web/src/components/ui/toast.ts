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

interface PendingDismiss {
  // null while paused — the countdown for that toast has no live timer to clear.
  timeoutId: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

// One entry per success toast still counting down, so a pause can freeze exactly the remaining
// time rather than restarting the full 5s once the reader moves on.
const pendingDismissals = new Map<number, PendingDismiss>();
let paused = false;

function armTimer(id: number, pending: PendingDismiss): void {
  pending.startedAt = Date.now();
  pending.timeoutId = setTimeout(() => {
    pendingDismissals.delete(id);
    dismissToast(id);
  }, pending.remainingMs);
}

function clearPending(id: number): void {
  const pending = pendingDismissals.get(id);
  if (pending?.timeoutId !== null && pending?.timeoutId !== undefined) {
    clearTimeout(pending.timeoutId);
  }
  pendingDismissals.delete(id);
}

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
  clearPending(id);
  toasts = toasts.filter((toast) => toast.id !== id);
  publish();
}

export function notify(kind: ToastKind, message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  publish();
  if (kind === 'success') {
    const pending: PendingDismiss = {
      timeoutId: null,
      remainingMs: SUCCESS_AUTO_DISMISS_MS,
      startedAt: Date.now(),
    };
    pendingDismissals.set(id, pending);
    // Paused on creation (the stack already has hover or focus-within) waits for resumeToasts()
    // to arm it, so a toast that arrives mid-interaction doesn't start counting down unseen.
    if (!paused) armTimer(id, pending);
  }
}

// Freezes every counting-down success toast at its remaining time, for as long as the stack has
// pointer hover or focus-within — a reader still looking at the stack must not have it change
// under them.
export function pauseToasts(): void {
  if (paused) return;
  paused = true;
  for (const pending of pendingDismissals.values()) {
    if (pending.timeoutId === null) continue;
    clearTimeout(pending.timeoutId);
    pending.remainingMs = Math.max(0, pending.remainingMs - (Date.now() - pending.startedAt));
    pending.timeoutId = null;
  }
}

// Resumes every frozen countdown from its remaining time, once the stack has neither hover nor
// focus-within.
export function resumeToasts(): void {
  if (!paused) return;
  paused = false;
  for (const [id, pending] of pendingDismissals) {
    armTimer(id, pending);
  }
}

// Resets the module-scope store. App.tsx calls this on logout; tests call it between cases.
// Pending timers are cleared, but nextId is not reset, so a toast created after a clear never
// reuses an id a still-mounted reference could be holding.
export function clearToasts(): void {
  for (const pending of pendingDismissals.values()) {
    if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
  }
  pendingDismissals.clear();
  paused = false;
  toasts = [];
  publish();
}
