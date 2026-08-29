import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Dialog from './Dialog';

describe('Dialog', () => {
  it('resolves by role and title when open', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose when the dialog fires its native close event', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete document' });
    dialog.dispatchEvent(new Event('close'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('defaults to the medium size', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toHaveClass('dialog--md');
  });

  it('applies the requested size modifier', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete document" size="lg">
        <p>Irreversible.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Delete document' })).toHaveClass('dialog--lg');
  });
});
