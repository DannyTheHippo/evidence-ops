import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SecretReveal from './SecretReveal';

describe('SecretReveal', () => {
  it('shows the secret, the caller-supplied notice, and an expiry, then clears on Dismiss', () => {
    const onDismiss = vi.fn();
    render(
      <SecretReveal
        secret="eo_inv_brandnewtoken123"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="This is the only time this link is shown."
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText('eo_inv_brandnewtoken123')).toBeInTheDocument();
    expect(screen.getByText('This is the only time this link is shown.')).toBeInTheDocument();
    expect(screen.getByText(/Expires/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders a caller-supplied extra action beside Copy and Dismiss', () => {
    render(
      <SecretReveal
        secret="eo_inv_brandnewtoken123"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        extraActions={<a href="mailto:new-hire@example.com">Email invite</a>}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'Email invite' })).toBeInTheDocument();
  });

  it('resets the Copy button state when a fresh secret replaces the previous one', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });

    const { rerender } = render(
      <SecretReveal
        secret="token-v1"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    rerender(
      <SecretReveal
        secret="token-v2"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('warns before an unload while mounted, and stays silent once unmounted', () => {
    function dispatchBeforeUnload(): Event {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event;
    }

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    const { unmount } = render(
      <SecretReveal
        secret="eo_inv_brandnewtoken123"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        onDismiss={vi.fn()}
      />,
    );

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    unmount();

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('accepts a ref on its section so a caller can move focus to it once the secret appears', () => {
    const ref = createRef<HTMLElement>();
    render(
      <SecretReveal
        ref={ref}
        secret="eo_inv_brandnewtoken123"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        onDismiss={vi.fn()}
      />,
    );

    ref.current?.focus();

    expect(ref.current).toHaveFocus();
  });

  it('names the section by its eyebrow, so a focus move announces the region', () => {
    render(
      <SecretReveal
        secret="eo_inv_brandnewtoken123"
        expiresAt="2099-01-01T00:00:00.000Z"
        notice="Copy it now."
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'One-time secret' })).toBeInTheDocument();
  });
});
