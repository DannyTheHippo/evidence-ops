import { act, fireEvent, render, screen } from '@testing-library/react';
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
});
