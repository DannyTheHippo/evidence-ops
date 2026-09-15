import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Alert from './Alert';

describe('Alert', () => {
  it('gives a rejected alert the assertive role', () => {
    render(<Alert tone="rejected">Something failed</Alert>);

    expect(screen.getByRole('alert')).toHaveTextContent('Something failed');
  });

  it.each([['verified'], ['caution'], ['info'], ['neutral']] as const)(
    'gives every other tone the status role (%s)',
    (tone) => {
      render(<Alert tone={tone}>Noted</Alert>);

      expect(screen.getByRole('status')).toHaveTextContent('Noted');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('renders a title when supplied', () => {
    render(
      <Alert tone="caution" title="Heads up">
        Body copy
      </Alert>,
    );

    expect(screen.getByText('Heads up')).toBeInTheDocument();
  });

  it('renders a trailing action', () => {
    render(
      <Alert tone="rejected" action={<button>Retry</button>}>
        Failed to load
      </Alert>,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
