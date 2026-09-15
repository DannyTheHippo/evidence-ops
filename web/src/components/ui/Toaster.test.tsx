import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Toaster from './Toaster';
import { clearToasts, getToasts, notify } from './toast';

describe('Toaster', () => {
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('renders a success message under role=status', () => {
    render(<Toaster />);

    act(() => {
      notify('success', 'API key minted.');
    });

    expect(screen.getByRole('status')).toHaveTextContent('API key minted.');
  });

  it('renders an error message under role=alert', () => {
    render(<Toaster />);

    act(() => {
      notify('error', 'Failed to mint API key.');
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to mint API key.');
  });

  it('removes a toast when its dismiss control is clicked', () => {
    render(<Toaster />);

    act(() => {
      notify('error', 'Failed to mint API key.');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('auto-dismisses a success toast, but never an error toast, on a timer', async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      notify('success', 'Saved.');
      notify('error', 'Failed to save.');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save.');
  });

  it('caps the visible stack at 3, showing the newest of each kind', () => {
    render(<Toaster />);

    act(() => {
      notify('success', 'First.');
      notify('success', 'Second.');
      notify('success', 'Third.');
      notify('success', 'Fourth.');
    });

    const visible = screen.getAllByRole('status').map((el) => el.textContent);
    expect(visible).toHaveLength(3);
    expect(visible).toEqual(['Fourth.', 'Third.', 'Second.']);
  });

  it('keeps an error toast visible with a reachable dismiss control over three successes', () => {
    render(<Toaster />);

    act(() => {
      notify('success', 'First.');
      notify('success', 'Second.');
      notify('success', 'Third.');
      notify('error', 'Failed to save.');
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to save.');
    expect(within(alert).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('keeps a hidden success toast auto-dismissing on schedule', async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      notify('success', 'First.');
      notify('success', 'Second.');
      notify('success', 'Third.');
      notify('success', 'Fourth.');
    });

    // "Fourth." pushes "First." out of the visible stack, but its timer is still running.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('holds a success toast while the stack has focus', async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      notify('success', 'Saved.');
    });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    act(() => {
      dismiss.focus();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => {
      fireEvent.focusOut(dismiss, { relatedTarget: document.body });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('announces a success toast through one live region', () => {
    render(<Toaster />);

    act(() => {
      notify('success', 'Saved.');
    });

    const status = screen.getByRole('status');
    expect(status).not.toHaveAttribute('aria-live');
    expect(status.closest('.toast-stack')).toHaveAttribute('aria-live', 'polite');
  });

  it('never reuses a toast id after clearToasts, and drops a timer armed before it', async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      notify('success', 'First.');
    });
    const firstId = getToasts()[0].id;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4900);
    });
    act(() => {
      clearToasts();
    });
    // First.'s timer had 100ms left when the clear ran; without clearToasts's own clearTimeout
    // loop it would still be scheduled here.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      notify('success', 'Second.');
    });
    const secondId = getToasts()[0].id;
    expect(secondId).not.toBe(firstId);

    // Second.'s own 5000ms timer isn't due yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(getToasts()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4800);
    });
    expect(getToasts()).toHaveLength(0);
  });

  it('reports hidden toasts beyond the cap', () => {
    render(<Toaster />);

    act(() => {
      notify('success', 'First.');
      notify('success', 'Second.');
      notify('success', 'Third.');
      notify('success', 'Fourth.');
    });

    expect(screen.getByText('1 more')).toBeInTheDocument();
  });
});
