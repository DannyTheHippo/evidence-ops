import { useEffect, useId, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { IconX } from '../icons';
import IconButton from './IconButton';
import { useModalDialog } from './use-modal-dialog';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  // Selects one of the three width tokens; defaults to 'md'.
  size?: 'sm' | 'md' | 'lg';
  // Edge the sheet enters from; defaults to 'end'.
  side?: 'start' | 'end';
  // Closes the drawer when the viewport crosses 768px upward — the mobile-nav case, where the
  // persistent sidebar takes over and a modal sheet would strand the user.
  closeOnWiden?: boolean;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const sizeClass: Record<NonNullable<DrawerProps['size']>, string> = {
  sm: 'drawer--sm',
  md: 'drawer--md',
  lg: 'drawer--lg',
};

const sideClass: Record<NonNullable<DrawerProps['side']>, string> = {
  start: 'drawer--start',
  end: 'drawer--end',
};

const WIDE_VIEWPORT_QUERY = '(min-width: 768px)';

/** Sheet variant of `Dialog`, built on the same native `<dialog>` and sharing its open/close/
 * focus-restore lifecycle through `useModalDialog`. Like `Dialog`, it always renders a close
 * control and a backdrop-press dismissal, and offers no prop to opt out of either. */
export default function Drawer({
  open,
  onClose,
  title,
  size = 'md',
  side = 'end',
  closeOnWiden = false,
  describedBy,
  initialFocusRef,
  children,
}: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const { requestClose } = useModalDialog({ open, onClose, dialogRef, initialFocusRef });

  useEffect(() => {
    // Real browsers always carry matchMedia; jsdom carries neither it nor a layout engine, so
    // this effect is simply inert under test rather than throwing.
    if (!open || !closeOnWiden || typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia(WIDE_VIEWPORT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) requestClose();
    };
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, [open, closeOnWiden, requestClose]);

  if (!open) return null;

  // A press on the sheet's own padding also targets the <dialog> element, so only a press whose
  // point falls outside the sheet's box counts as the backdrop.
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
      className={`drawer ${sizeClass[size]} ${sideClass[side]}`}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClose={onClose}
      onPointerDown={handleBackdropPointerDown}
    >
      <div className="drawer-head">
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
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
