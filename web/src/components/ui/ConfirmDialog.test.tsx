import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('fires onConfirm once per click and cannot double-fire while busy', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Revoke session"
        body="This signs the device out immediately."
        confirmLabel="Revoke"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onConfirm).toHaveBeenCalledOnce();

    rerender(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Revoke session"
        body="This signs the device out immediately."
        confirmLabel="Revoke"
        busy
        onConfirm={onConfirm}
      />,
    );

    const busyButton = screen.getByRole('button', { name: 'Revoke…' });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open with cancel reachable while an error is showing', () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Revoke session"
        body="This signs the device out immediately."
        confirmLabel="Revoke"
        error="Failed to revoke session."
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Revoke session' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to revoke session.');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    expect(cancelButton).toBeEnabled();
    fireEvent.click(cancelButton);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the danger variant when destructive', () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Delete document"
        body="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('btn--danger');
  });
});
