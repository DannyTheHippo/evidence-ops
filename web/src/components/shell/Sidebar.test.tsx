import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';

describe('Sidebar', () => {
  it('marks the active nav link with aria-current and leaves others unmarked', () => {
    render(
      <MemoryRouter initialEntries={['/ask']}>
        <Sidebar isAdmin={false} drawerOpen={false} onCloseDrawer={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Ask' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('shows the Audit Log link to an admin and hides it from a member', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar isAdmin onCloseDrawer={() => {}} drawerOpen={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar isAdmin={false} onCloseDrawer={() => {}} drawerOpen={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
  });

  it('renders the drawer nav inside a dialog once open', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar isAdmin={false} drawerOpen onCloseDrawer={() => {}} />
      </MemoryRouter>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(dialog).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('closes the drawer when a drawer nav link is clicked', () => {
    const onCloseDrawer = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar isAdmin={false} drawerOpen onCloseDrawer={onCloseDrawer} />
      </MemoryRouter>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Home' }));

    expect(onCloseDrawer).toHaveBeenCalled();
  });

  it('renders no dialog when the drawer is closed', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar isAdmin={false} drawerOpen={false} onCloseDrawer={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
