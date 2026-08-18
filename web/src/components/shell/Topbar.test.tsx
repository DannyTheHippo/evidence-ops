import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Topbar from './Topbar';

describe('Topbar', () => {
  it('renders the breadcrumb label and wires the menu and logout controls', () => {
    const onOpenMenu = vi.fn();
    const onLogout = vi.fn();
    render(<Topbar breadcrumbLabel="Sources" onOpenMenu={onOpenMenu} onLogout={onLogout} />);

    expect(screen.getByText('Sources')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onOpenMenu).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
