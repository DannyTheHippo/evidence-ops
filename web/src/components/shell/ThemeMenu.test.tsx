import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from './ThemeMenu';
import ThemeMenu from './ThemeMenu';

const openMenu = (triggerName: string) => {
  fireEvent.click(screen.getByRole('button', { name: triggerName }));
};

describe('ThemeMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('opens a menu of System, Light and Dark and marks the current one', () => {
    render(<ThemeMenu />);

    openMenu('Theme: System');

    expect(screen.getByRole('menuitem', { name: 'System, current' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Dark' })).toBeInTheDocument();
  });

  it('selecting Dark from System applies and persists it without passing through Light', () => {
    render(<ThemeMenu />);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    openMenu('Theme: System');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).not.toBe('light');
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark');
  });

  it('reflects a stored value on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    render(<ThemeMenu />);

    expect(document.documentElement.dataset.theme).toBe('light');
    openMenu('Theme: Light');
    expect(screen.getByRole('menuitem', { name: 'Light, current' })).toBeInTheDocument();
  });

  it('still works when localStorage throws', () => {
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
      render(<ThemeMenu />);
      openMenu('Theme: System');

      // A write that throws must not break the selection — the mode still applies for this session.
      fireEvent.click(screen.getByRole('menuitem', { name: 'Dark' }));
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });
});
