import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  // Points aria-describedby at a caller-owned element id, e.g. a confirmation's body text, so a
  // screen reader announces the explanation alongside the title rather than only the title.
  describedBy?: string;
  // Selects one of the three width tokens in `primitives.css`; defaults to `'md'`.
  size?: 'sm' | 'md' | 'lg';
  // Element to focus once the dialog is open, overriding the native first-focusable-element
  // default. Applied as the last step of the same effect that calls `showModal()`, after
  // `showModal()`'s own initial-focus placement rather than racing it — the whole open/close
  // focus lifecycle (this, and the restore-on-close below) lives in one place rather than
  // split across this component and its callers.
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const sizeClass: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'dialog--sm',
  md: 'dialog--md',
  lg: 'dialog--lg',
};

/** Native `<dialog>` driven by `showModal()`/`close()` — focus trap, Escape-to-close, backdrop and
 * inertness are browser behaviour, not hand-rolled here. The native `close` event (Escape, or a
 * programmatic `close()`) is the single path to `onClose`, so a caller-triggered close and a
 * keyboard-triggered one both flow through the same prop. */
export default function Dialog({
  open,
  onClose,
  title,
  describedBy,
  size = 'md',
  initialFocusRef,
  children,
}: DialogProps) {
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
      restoreFocusTo.current?.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`dialog ${sizeClass[size]}`}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClose={onClose}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
