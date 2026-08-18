import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Native `<dialog>` driven by `showModal()`/`close()` — focus trap, Escape-to-close, backdrop and
 * inertness are browser behaviour, not hand-rolled here. The native `close` event (Escape, or a
 * programmatic `close()`) is the single path to `onClose`, so a caller-triggered close and a
 * keyboard-triggered one both flow through the same prop. */
export default function Dialog({ open, onClose, title, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // jsdom does not implement showModal()/close() — this is a UI affordance, so it fails OPEN
    // (rendering the dialog visibly) rather than throwing or swallowing the content, whether the
    // method is simply absent or present but non-functional.
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }

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
      restoreFocusTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
