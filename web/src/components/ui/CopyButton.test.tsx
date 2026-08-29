import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CopyButton from './CopyButton';

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('CopyButton', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('reports failure rather than appearing to work when the clipboard is absent', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<CopyButton text="secret-token" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy to clipboard.');
  });

  it('confirms a successful copy visually and via the status region', async () => {
    stubClipboard(() => Promise.resolve());
    render(<CopyButton text="secret-token" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard.');
  });

  it('renders icon-only with an aria-label and no visible text when iconOnly is set', () => {
    render(<CopyButton text="secret-token" iconOnly />);

    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button).not.toHaveTextContent('Copy');
  });

  it('resets the copied announcement when the text prop changes, e.g. after a token rotation', async () => {
    stubClipboard(() => Promise.resolve());
    const { rerender } = render(<CopyButton text="token-v1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    rerender(<CopyButton text="token-v2" />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
