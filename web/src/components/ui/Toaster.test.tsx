import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Toaster from './Toaster';
import { clearToasts, notify } from './toast';

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
});
