import { useId, useRef } from 'react';
import Button from './Button';
import Dialog from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
}

/** Shared confirmation for a destructive or irreversible action — revoking a session, removing a
 * member, deleting an entity. Built on `Dialog` rather than reimplementing modal behaviour; `body`
 * is wired to `Dialog`'s `describedBy` so a screen reader announces the explanation alongside the
 * title. `destructive` selects the danger confirm button over the primary one and, via `Dialog`'s
 * `initialFocusRef`, moves initial focus to Cancel — so the keyboard default on an irreversible
 * action is the safe one rather than the DOM order's Confirm. `busy` disables both buttons and
 * relabels the confirm action, which is what stops a double-click from firing `onConfirm` twice on
 * an action that cannot be undone. `error` renders inline in the app's existing error style and the
 * dialog stays open; cancel is disabled only by `busy`, never by `error`, so a failed confirm never
 * traps the user behind a lost explanation. */
export default function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      describedBy={bodyId}
      initialFocusRef={destructive ? cancelRef : undefined}
    >
      <p id={bodyId}>{body}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button variant={destructive ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
          {busy ? `${confirmLabel}…` : confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy} ref={cancelRef}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
