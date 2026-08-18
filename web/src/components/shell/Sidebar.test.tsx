import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';

type SidebarProps = ComponentProps<typeof Sidebar>;

function renderSidebar(props: Partial<SidebarProps> = {}, initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Sidebar
        isAdmin={false}
        drawerOpen={false}
        onCloseDrawer={() => {}}
        collapsed={false}
        onToggleCollapsed={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('marks the active nav link with aria-current and leaves others unmarked', () => {
    renderSidebar({}, ['/ask']);

    expect(screen.getByRole('link', { name: 'Ask' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('shows the Audit Log link to an admin and hides it from a member', () => {
    const { rerender } = renderSidebar({ isAdmin: true });
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar
          isAdmin={false}
          drawerOpen={false}
          onCloseDrawer={() => {}}
          collapsed={false}
          onToggleCollapsed={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
  });

  it('renders the drawer nav inside a dialog once open', () => {
    renderSidebar({ drawerOpen: true });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(dialog).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('closes the drawer when a drawer nav link is clicked', () => {
    const onCloseDrawer = vi.fn();
    renderSidebar({ drawerOpen: true, onCloseDrawer });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Home' }));

    expect(onCloseDrawer).toHaveBeenCalled();
  });

  it('renders no dialog when the drawer is closed', () => {
    renderSidebar();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the collapse control for the action it performs and reports the current state', () => {
    const { rerender } = renderSidebar({ collapsed: false });

    const expanded = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar
          isAdmin={false}
          drawerOpen={false}
          onCloseDrawer={() => {}}
          collapsed
          onToggleCollapsed={() => {}}
        />
      </MemoryRouter>,
    );

    const collapsed = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(collapsed).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onToggleCollapsed when the collapse control is clicked', () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar({ onToggleCollapsed });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('keeps every nav link reachable when collapsed, since the rail only hides the text', () => {
    renderSidebar({ collapsed: true });

    // The labels are hidden with CSS, so the accessible name still resolves — a collapsed rail
    // must not cost a screen-reader user the navigation.
    expect(screen.getByRole('link', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveClass('sidebar--collapsed');
  });
});
