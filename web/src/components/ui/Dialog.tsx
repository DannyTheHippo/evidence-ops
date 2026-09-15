import { useId, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { IconX } from '../icons';
import IconButton from './IconButton';
import { useModalDialog } from './use-modal-dialog';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  // Points aria-describedby at a caller-owned element id, e.g. a confirmation's body text, so a
  // screen reader announces the explanation alongside the title rather than only the title.
  describedBy?: string;
  // Selects one of the three width tokens in `primitives.css`; defaults to `'md'`.
  size?: 'sm' | 'md' | 'lg';
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Focus target on close when the opener has left the document; see `useModalDialog`.
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const sizeClass: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'dialog--sm',
  md: 'dialog--md',
  lg: 'dialog--lg',
};

/** Native `<dialog>` driven by `showModal()`/`close()` — focus trap, Escape-to-close, backdrop and
 * inertness are browser behaviour, not hand-rolled here. The native `close` event (Escape, the
 * header close control, a backdrop press, or a programmatic `close()`) is the single path to
 * `onClose`, so every dismissal flows through the same prop. */
export default function Dialog({
  open,
  onClose,
  title,
  describedBy,
  size = 'md',
  initialFocusRef,
  fallbackFocusRef,
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const { requestClose } = useModalDialog({
    open,
    onClose,
    dialogRef,
    initialFocusRef,
    fallbackFocusRef,
  });

  if (!open) return null;

  // A press on the dialog's own padding also targets the <dialog> element, so only a press whose
  // point falls outside the dialog's box counts as the backdrop.
  const handleBackdropPointerDown = (event: PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog || event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    ) {
      requestClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={`dialog ${sizeClass[size]}`}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClose={onClose}
      onPointerDown={handleBackdropPointerDown}
    >
      <div className="dialog-head">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <IconButton
          icon={<IconX />}
          aria-label="Close"
          variant="ghost"
          size="sm"
          onClick={requestClose}
        />
      </div>
      {children}
    </dialog>
  );
}
