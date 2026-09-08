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
  overrides: {
    conflictsCount?: number;
    approvalsCount?: number;
    approvalsFail?: boolean;
    conflictsFail?: boolean;
    measuresCount?: number;
  } = {},
) {
  const {
    conflictsCount = 0,
    approvalsCount = 0,
    approvalsFail = false,
    conflictsFail = false,
    measuresCount = 0,
  } = overrides;
  return vi.fn((url: string) => {
    if (url.startsWith('/api/v1/conflicts')) {
      return conflictsFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: conflictsCount }));
    }
    if (url.startsWith('/api/v1/approvals')) {
      return approvalsFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: approvalsCount }));
    }
    if (url.startsWith('/api/v1/measures')) {
      return Promise.resolve(jsonResponse({ docs: [], count: measuresCount }));
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
    renderSidebar({}, ['/ledger']);

    expect(screen.getByRole('link', { name: 'Ledger' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('groups the nav into Estate and Ledger, with no group heading for Home, Adjudication, Answers or Runs', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar();

    expect(screen.getByRole('heading', { name: 'Estate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ledger' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Adjudication' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Answers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'API keys' })).toBeInTheDocument();
  });

  it('shows the Admin group, with People, Audit events and Aliases and entities, only to an admin', () => {
    vi.stubGlobal('fetch', fetchStub());
    const { rerender } = renderSidebar({ isAdmin: true });

    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit events' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aliases and entities' })).toBeInTheDocument();

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

    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Aliases and entities' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Ledger' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveClass('sidebar--collapsed');
  });

  it('folds the Adjudication and Measures queue counts into their link names', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 3, approvalsCount: 0, measuresCount: 2 }));
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: 'Adjudication, 3 pending' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: 'Measures queue, 2 pending' }),
    ).toBeInTheDocument();
  });

  it('sums Adjudication from whichever of conflicts/approvals resolved when one fails', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 2, approvalsFail: true }));
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: 'Adjudication, 2 pending' }),
    ).toBeInTheDocument();
  });

  it('renders no Adjudication badge when both conflicts and approvals fail', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsFail: true, approvalsFail: true }));
    renderSidebar();

    expect(await screen.findByRole('link', { name: 'Adjudication' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Adjudication, /i })).not.toBeInTheDocument();
  });

  it('renders no pending-count badge while the session is still anonymous', () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 5 }));
    renderSidebar();

    // usePendingCounts waits on an authed session before it fetches at all, so the badge-bearing
    // name never appears even though the stub above would otherwise supply a count.
    expect(screen.getByRole('link', { name: 'Adjudication' })).toBeInTheDocument();
  });
});
