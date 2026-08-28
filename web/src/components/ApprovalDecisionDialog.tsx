import { useId, useRef, useState } from 'react';
import type { ApprovalDecision } from '../api/client';
import Button from './ui/Button';
import Dialog from './ui/Dialog';
import Field from './ui/Field';

export interface ApprovalDecisionDialogProps {
  /** `null` when closed; the direction otherwise — sets the dialog's title and the confirm
   * button's tone. */
  decision: ApprovalDecision | null;
  summary: string;
  /** Whether deciding this approval resumes a parked workflow run — `ApprovalsPage`'s detail pane
   * passes `!!approval.workflowId`, `WorkflowRunPage` always `true`, since the approval it decides
   * is by definition the one gating the run it renders. */
  resumesWorkflow: boolean;
  onClose: () => void;
  /** Persists the decision. The dialog awaits it, disabling both buttons and holding the dialog
   * open until it settles: resolving closes the dialog (by the caller flipping `decision` back to
   * `null`), rejecting renders the thrown message inline and leaves the dialog open to retry. */
  onConfirm: (decision: ApprovalDecision, reason: string | undefined) => Promise<void>;
}

/** Approve/reject dialog shared by `ApprovalsPage`'s detail pane and `WorkflowRunPage`'s inline
 * timeline — both park a workflow on the identical decision shape. Owns the reason input,
 * in-flight state, and error display; the caller owns persistence, notifying, and closing. A
 * synchronous ref, not just `disabled={busy}`, blocks a second confirm fired between a click and
 * the re-render that disables the button — `disabled` only takes effect once React has committed
 * it. */
export default function ApprovalDecisionDialog({
  decision,
  summary,
  resumesWorkflow,
  onClose,
  onConfirm,
}: ApprovalDecisionDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const bodyId = useId();

  function handleClose() {
    setReason('');
    setError(null);
    onClose();
  }

  async function handleConfirm() {
    if (!decision || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(decision, reason.trim() || undefined);
      setReason('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record decision');
    } finally {
      setBusy(false);
      submitInFlightRef.current = false;
    }
  }

  return (
    <Dialog
      open={decision !== null}
      onClose={handleClose}
      title={decision === 'rejected' ? 'Reject this approval' : 'Approve this approval'}
      describedBy={bodyId}
    >
      <div className="form">
        <p id={bodyId}>{summary}</p>
        <p className="cell-sub">
          {resumesWorkflow
            ? 'This decision resumes the parked workflow run.'
            : 'This decision will be recorded.'}
        </p>
        <Field label="Reason (optional)">
          {(inputProps) => (
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Evidence checks out."
              disabled={busy}
              {...inputProps}
            />
          )}
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            variant={decision === 'rejected' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {decision === 'rejected' ? 'Reject' : 'Approve'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={handleClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
