import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, ThemeToggle } from './ThemeToggle';

// The control is one button whose accessible name states both the current mode and the one a
// press moves to, so every query here goes through that combined name.
const nameFor = (current: string, next: string) => `Theme: ${current}. Switch to ${next}.`;

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('renders a single control naming the current mode and the next one', () => {
    render(<ThemeToggle />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: nameFor('System', 'Light') })).toBeInTheDocument();
  });

  it('cycles System → Light → Dark → System, applying and persisting each step', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button', { name: nameFor('System', 'Light') }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: nameFor('Light', 'Dark') }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // Wrapping back to System must clear the attribute, handing control to prefers-color-scheme.
    fireEvent.click(screen.getByRole('button', { name: nameFor('Dark', 'System') }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('reflects a pre-existing stored value on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: nameFor('Light', 'Dark') })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('still renders starting from System when localStorage throws', () => {
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => {
          throw new Error('storage disabled');
        },
      },
    });

    try {
      render(<ThemeToggle />);
      const button = screen.getByRole('button', { name: nameFor('System', 'Light') });

      // A write that throws must not break the click — the mode still applies for this session.
      fireEvent.click(button);
      expect(document.documentElement.dataset.theme).toBe('light');
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });
});
