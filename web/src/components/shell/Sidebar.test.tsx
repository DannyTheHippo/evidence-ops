import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../lib/auth';
import Sidebar from './Sidebar';

type SidebarProps = ComponentProps<typeof Sidebar>;

const member = {
  id: 'user-1',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Routes every request by its path — `usePendingCounts` mounts alongside the nav in every test
 * here, so a stub answering only `/conflicts`/`/approvals` would leave any other in-flight call
 * unresolved. `conflictsCount`/`approvalsCount` default to a healthy `0` (no badge, no failure) so
 * a test only has to name the field it cares about. */
function fetchStub(
  overrides: { conflictsCount?: number; approvalsCount?: number; approvalsFail?: boolean } = {},
) {
  const { conflictsCount = 0, approvalsCount = 0, approvalsFail = false } = overrides;
  return vi.fn((url: string) => {
    if (url.startsWith('/api/v1/conflicts')) {
      return Promise.resolve(jsonResponse({ docs: [], count: conflictsCount }));
    }
    if (url.startsWith('/api/v1/approvals')) {
      return approvalsFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: approvalsCount }));
    }
    return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
  });
}

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
  // `usePendingCounts` reads `useSession()`, so every test needs a resolved session one way or
  // another; defaulting to an authed member here means only the anonymous-specific test below has
  // to override it.
  beforeEach(() => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    auth.clearSession();
  });

  it('marks the active nav link with aria-current and leaves others unmarked', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({}, ['/ask']);

    expect(screen.getByRole('link', { name: 'Ask' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('groups the nav into Ask, Evidence, Review queue and Account, with no group heading for Home', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar();

    expect(screen.getByRole('heading', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'API Keys' })).toBeInTheDocument();
  });

  it('shows the Organisation group, with People, Aliases and Audit Log, only to an admin', () => {
    vi.stubGlobal('fetch', fetchStub());
    const { rerender } = renderSidebar({ isAdmin: true });

    expect(screen.getByRole('heading', { name: 'Organisation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aliases' })).toBeInTheDocument();

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

    expect(screen.queryByRole('heading', { name: 'Organisation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Aliases' })).not.toBeInTheDocument();
  });

  it('renders the drawer nav inside a dialog once open', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ drawerOpen: true });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(dialog).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('closes the drawer when a drawer nav link is clicked', () => {
    vi.stubGlobal('fetch', fetchStub());
    const onCloseDrawer = vi.fn();
    renderSidebar({ drawerOpen: true, onCloseDrawer });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Home' }));

    expect(onCloseDrawer).toHaveBeenCalled();
  });

  it('renders no dialog when the drawer is closed', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the collapse control for the action it performs and reports the current state', () => {
    vi.stubGlobal('fetch', fetchStub());
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
    vi.stubGlobal('fetch', fetchStub());
    const onToggleCollapsed = vi.fn();
    renderSidebar({ onToggleCollapsed });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('keeps every nav link reachable when collapsed, since the rail only hides the text', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ collapsed: true });

    // The labels are hidden with CSS, so the accessible name still resolves — a collapsed rail
    // must not cost a screen-reader user the navigation.
    expect(screen.getByRole('link', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveClass('sidebar--collapsed');
  });

  it('folds a pending count into the link name and renders no badge for a zero count', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 3, approvalsCount: 0 }));
    renderSidebar();

    expect(await screen.findByRole('link', { name: 'Conflicts, 3 pending' })).toBeInTheDocument();
    // Approvals stayed at 0 — no "pending" suffix, no visible badge text.
    expect(screen.getByRole('link', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.queryByText('· 0')).not.toBeInTheDocument();
  });

  it('leaves the rest of the nav intact when a pending count fetch fails', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 2, approvalsFail: true }));
    renderSidebar();

    // The count that resolved still renders...
    expect(await screen.findByRole('link', { name: 'Conflicts, 2 pending' })).toBeInTheDocument();
    // ...and the one that failed falls back to a plain, badge-less link rather than breaking the
    // group around it.
    expect(screen.getByRole('link', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review queue' })).toBeInTheDocument();
  });

  it('renders no pending-count badge while the session is still anonymous', () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 5 }));
    renderSidebar();

    // usePendingCounts waits on an authed session before it fetches at all, so the badge-bearing
    // name never appears even though the stub above would otherwise supply a count.
    expect(screen.getByRole('link', { name: 'Conflicts' })).toBeInTheDocument();
  });
});
