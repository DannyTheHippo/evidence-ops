import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../lib/auth';
import Topbar from './Topbar';

const ME = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member' as const,
  createdAt: '2026-01-15T00:00:00.000Z',
};

function mockAuthedSession() {
  vi.spyOn(auth, 'ensureSession').mockResolvedValue(ME);
}

describe('Topbar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the breadcrumb label and wires the menu-open control', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    const onOpenMenu = vi.fn();
    const onLogout = vi.fn();
    render(<Topbar breadcrumbLabel="Sources" onOpenMenu={onOpenMenu} onLogout={onLogout} />);

    expect(screen.getByText('Sources')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onOpenMenu).toHaveBeenCalledOnce();
  });

  it('shows the account trigger as "Account" while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(<Topbar breadcrumbLabel="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  it('shows email, role and member-since as informational items beside a real Logout action', async () => {
    mockAuthedSession();
    const onLogout = vi.fn();
    render(<Topbar breadcrumbLabel="Sources" onOpenMenu={() => {}} onLogout={onLogout} />);

    const trigger = await screen.findByRole('button', { name: 'user@example.com' });
    fireEvent.click(trigger);

    const emailItem = screen.getByRole('menuitem', { name: 'user@example.com' });
    const roleItem = screen.getByRole('menuitem', { name: 'Member' });
    const memberSinceItem = screen.getByRole('menuitem', {
      name: `Member since ${new Date(ME.createdAt).toLocaleDateString()}`,
    });
    expect(emailItem).toHaveAttribute('aria-disabled', 'true');
    expect(roleItem).toHaveAttribute('aria-disabled', 'true');
    expect(memberSinceItem).toHaveAttribute('aria-disabled', 'true');

    const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });
    expect(logoutItem).not.toHaveAttribute('aria-disabled');
    fireEvent.click(logoutItem);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('opens the account menu on click, moves focus with ArrowDown, closes on Escape and returns focus to the trigger', async () => {
    mockAuthedSession();
    render(<Topbar breadcrumbLabel="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    const trigger = await screen.findByRole('button', { name: 'user@example.com' });
    trigger.focus();
    fireEvent.click(trigger);

    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(items[1], { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
