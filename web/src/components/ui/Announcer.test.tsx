import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Announcer from './Announcer';

describe('Announcer', () => {
  it('mounts the live region before any message', () => {
    render(<Announcer />);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent('');
  });

  it('re-announces an identical repeated message', () => {
    let listener: ((message: string) => void) | undefined;
    const subscribe = (l: (message: string) => void) => {
      listener = l;
    };
    const unsubscribe = () => {
      listener = undefined;
    };

    render(<Announcer subscribe={subscribe} unsubscribe={unsubscribe} />);
    const region = screen.getByRole('status');

    act(() => listener?.('Saved.'));
    expect(region.textContent).toBe('Saved.');

    act(() => listener?.('Saved.'));
    expect(region.textContent).toBe('Saved.\u200b');
    expect(region.textContent).not.toBe('Saved.');
  });
});
