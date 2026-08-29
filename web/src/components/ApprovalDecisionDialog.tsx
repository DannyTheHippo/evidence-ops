import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ApprovalDecision } from '../api/client';
import { useFormSubmit } from '../lib/use-form-submit';
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
   * open until it settles: resolving lets the caller flip `decision` back to `null`, rejecting
   * renders the thrown message inline and leaves the dialog open to retry. */
  onConfirm: (decision: ApprovalDecision, reason: string | undefined) => Promise<void>;
}

interface DecisionFormProps {
  decision: ApprovalDecision;
  summary: string;
  resumesWorkflow: boolean;
  bodyId: string;
  onClose: () => void;
  onConfirm: (decision: ApprovalDecision, reason: string | undefined) => Promise<void>;
}

/** The reason field and its submit lifecycle for one open of the dialog. Mounted only while a
 * decision is set — see the `key`ed usage below — so every fresh open starts `useFormSubmit`
 * clean instead of replaying a prior open's reason text or server error. */
function DecisionForm({
  decision,
  summary,
  resumesWorkflow,
  bodyId,
  onClose,
  onConfirm,
}: DecisionFormProps) {
  const [reason, setReason] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<'reason'>({
    submit: () => onConfirm(decision, reason.trim() || undefined),
  });
  const { id: reasonId, error: reasonError, onBlur: reasonBlur } = fieldProps('reason');

  // Enter submits, matching a single-line control; Shift+Enter still inserts a newline, since the
  // field is a multi-line textarea.
  function handleReasonKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="form" noValidate>
      <p id={bodyId}>{summary}</p>
      <p className="cell-sub">
        {resumesWorkflow
          ? 'This decision resumes the parked workflow run.'
          : 'This decision will be recorded.'}
      </p>
      <Field id={reasonId} label="Reason" optional error={reasonError}>
        {(inputProps) => (
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={reasonBlur}
            onKeyDown={handleReasonKeyDown}
            placeholder="Evidence checks out."
            disabled={pending}
            {...inputProps}
          />
        )}
      </Field>
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      <div className="form-actions">
        <Button
          type="submit"
          variant={decision === 'rejected' ? 'danger' : 'primary'}
          disabled={pending}
        >
          {decision === 'rejected' ? 'Reject' : 'Approve'}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Approve/reject dialog shared by `ApprovalsPage`'s detail pane, `WorkflowRunPage`'s inline
 * timeline, and `HomePage`'s pending-approvals card — all three park a workflow on the identical
 * decision shape. Owns the reason input and its submit lifecycle via `useFormSubmit`; the caller
 * owns persistence, notifying, and closing. */
export default function ApprovalDecisionDialog({
  decision,
  summary,
  resumesWorkflow,
  onClose,
  onConfirm,
}: ApprovalDecisionDialogProps) {
  const bodyId = useId();

  return (
    <Dialog
      open={decision !== null}
      onClose={onClose}
      title={decision === 'rejected' ? 'Reject this approval' : 'Approve this approval'}
      describedBy={bodyId}
      size="sm"
    >
      {decision && (
        <DecisionForm
          key={decision}
          decision={decision}
          summary={summary}
          resumesWorkflow={resumesWorkflow}
          bodyId={bodyId}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Dialog>
  );
}
