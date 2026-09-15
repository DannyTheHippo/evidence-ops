import { useCallback, useEffect, useRef, type RefObject } from 'react';

interface UseModalDialogOptions {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
  // Element to focus once the dialog is open, overriding the native first-focusable-element
  // default. Applied as the last step of the open effect, after showModal()'s own initial-focus
  // placement rather than racing it.
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Element to focus on close when a focused element opened the dialog and has since left the
  // document, e.g. a row action the confirmed change removed. Without one, or when it is detached
  // too, focus moves to the page heading (`#main-content h1`). Neither is consulted when no element
  // held focus at open, or when a live element outside the dialog already holds focus at close.
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

interface UseModalDialogResult {
  // Routes a caller-triggered dismissal (a close control, a backdrop press) through the same
  // native close() the Escape key uses, so onClose stays the single path. jsdom implements no
  // close() at all: falls open by calling onClose directly there, exactly as the open effect
  // below fails open for showModal().
  requestClose: () => void;
}

/** Open/close/focus-restore lifecycle shared by `Dialog` and `Drawer` — both are native `<dialog>`
 * driven by `showModal()`/`close()`, so a caller opts into a modal top-layer surface, a focus trap
 * and Escape-to-close simply by rendering one. jsdom implements neither `showModal()` nor
 * `close()`: this is a UI affordance, so both fail OPEN (setting/removing the `open` attribute
 * directly) rather than throwing or swallowing the dialog's content. */
export function useModalDialog({
  open,
  onClose,
  dialogRef,
  initialFocusRef,
  fallbackFocusRef,
}: UseModalDialogOptions): UseModalDialogResult {
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }

    // After showModal()'s own initial-focus placement, so an explicit target wins over the
    // native first-focusable-element default rather than racing it.
    initialFocusRef?.current?.focus();

    return () => {
      if (typeof dialog.close === 'function') {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute('open');
        }
      } else {
        dialog.removeAttribute('open');
      }
      // Explicit fallback: current browsers restore focus to the invoking element through
      // dialog.close() itself, but the parent unmounting this component (flipping `open` to
      // false) removes the dialog from the DOM before that has a chance to run — and jsdom does
      // not implement the restore at all. Doing it here covers both.
      const opener = restoreFocusTo.current;
      // No element held focus at open: Safari and Firefox on macOS, and iOS Safari, do not focus a
      // button on click, so a pointer-opened dialog records `body`. There is nothing to restore,
      // so focus stays wherever the browser puts it and the page does not scroll.
      if (!opener || opener === document.body) return;
      if (opener.isConnected) {
        opener.focus();
        return;
      }
      // The opener has left the document, so focusing it would leave focus on `body`. A live
      // element outside the dialog that already holds focus keeps it; otherwise focus moves to the
      // caller's fallback, then to the page heading. Both use `preventScroll`: this is a restore,
      // not a navigation, and the heading sits at the top of the `#main-content` scroll container,
      // so a scrolling focus would move the operator away from the rows they were working on.
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && !dialog.contains(active)) {
        return;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- read at close on purpose: the fallback is whatever node the ref holds after the confirmed change re-rendered, not the node at open
      const fallback = fallbackFocusRef?.current;
      const target = fallback?.isConnected
        ? fallback
        : document.querySelector<HTMLElement>('#main-content h1');
      target?.focus({ preventScroll: true });
    };
  }, [open, dialogRef, initialFocusRef, fallbackFocusRef]);

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.close === 'function') {
      try {
        dialog.close();
        return;
      } catch {
        // native close() threw; fall through to the direct callback below
      }
    }
    onClose();
  }, [dialogRef, onClose]);

  return { requestClose };
}
