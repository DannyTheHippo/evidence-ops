import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ApprovalDecisionDialog from './ApprovalDecisionDialog';

function renderDialog(overrides: Partial<Parameters<typeof ApprovalDecisionDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <ApprovalDecisionDialog
      decision="approved"
      summary="Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%."
      resumesWorkflow
      onClose={onClose}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...result, onClose, onConfirm };
}

describe('ApprovalDecisionDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ decision: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('titles itself and tones the confirm button by decision direction', () => {
    const { rerender } = render(
      <ApprovalDecisionDialog
        decision="approved"
        summary="Approve me"
        resumesWorkflow
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Approve this approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();

    rerender(
      <ApprovalDecisionDialog
        decision="rejected"
        summary="Reject me"
        resumesWorkflow
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Reject this approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('shows the resumes-workflow copy only when resumesWorkflow is true', () => {
    const { rerender } = renderDialog({ resumesWorkflow: false });
    expect(screen.getByText('This decision will be recorded.')).toBeInTheDocument();

    rerender(
      <ApprovalDecisionDialog
        decision="approved"
        summary="Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%."
        resumesWorkflow
        onClose={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText('This decision resumes the parked workflow run.')).toBeInTheDocument();
  });

  it('confirms with the trimmed reason and the dialog decision, or undefined when left blank', async () => {
    const { onConfirm } = renderDialog();

    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: '  Evidence checks out.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('approved', 'Evidence checks out.');
    });
  });

  it('shows the thrown error inline and leaves the dialog open on a failed confirm', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Approval already decided'));
    renderDialog({ onConfirm });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Approval already decided')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('guards against a double submit between the click and the button becoming disabled', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onConfirm });

    const confirmButton = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it('cancelling clears the reason and closes without confirming', () => {
    const { onClose, onConfirm } = renderDialog();

    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'Draft reason' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
