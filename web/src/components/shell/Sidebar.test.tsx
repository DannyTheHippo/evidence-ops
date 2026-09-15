import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    vi.useRealTimers();
    auth.clearSession();
  });

  it('marks the active nav link with aria-current and leaves others unmarked', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({}, ['/ledger']);

    expect(screen.getByRole('link', { name: 'Ledger' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('groups the nav into Estate, Ledger, Work and Admin lists, with Home alone and no heading elements', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ isAdmin: true });

    expect(screen.getByRole('list', { name: 'Estate' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Ledger' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();

    const workList = within(screen.getByRole('list', { name: 'Work' }));
    expect(workList.getByRole('link', { name: 'Adjudication' })).toBeInTheDocument();
    expect(workList.getByRole('link', { name: 'Answers' })).toBeInTheDocument();
    expect(workList.getByRole('link', { name: 'Runs' })).toBeInTheDocument();

    const adminList = within(screen.getByRole('list', { name: 'Admin' }));
    expect(adminList.getByRole('link', { name: 'API keys' })).toBeInTheDocument();

    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('shows the Admin list with People, Audit events and Entities only to an admin; a member sees Admin with API keys only', () => {
    vi.stubGlobal('fetch', fetchStub());
    const { rerender } = renderSidebar({ isAdmin: true });

    const adminList = screen.getByRole('list', { name: 'Admin' });
    expect(within(adminList).getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(within(adminList).getByRole('link', { name: 'Audit events' })).toBeInTheDocument();
    expect(within(adminList).getByRole('link', { name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entities' })).toBeInTheDocument();

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

    const memberAdminList = within(screen.getByRole('list', { name: 'Admin' }));
    expect(memberAdminList.getByRole('link', { name: 'API keys' })).toBeInTheDocument();
    expect(memberAdminList.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    expect(memberAdminList.queryByRole('link', { name: 'Audit events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Entities' })).not.toBeInTheDocument();
  });

  it('names the brand without aria-label, exposing the visible text as its accessible name', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByText('Evidence Ops')).toBeInTheDocument();
  });

  it('renders the drawer nav inside a navigation landmark within the dialog', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ drawerOpen: true });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    const nav = within(dialog).getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('closes the drawer when a drawer nav link is clicked', () => {
    vi.stubGlobal('fetch', fetchStub());
    const onCloseDrawer = vi.fn();
    renderSidebar({ drawerOpen: true, onCloseDrawer });

    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Home' }));

    expect(onCloseDrawer).toHaveBeenCalled();
  });

  it('closes the drawer from its Close button', () => {
    vi.stubGlobal('fetch', fetchStub());
    const onCloseDrawer = vi.fn();
    renderSidebar({ drawerOpen: true, onCloseDrawer });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onCloseDrawer).toHaveBeenCalled();
  });

  it('closes the drawer on a backdrop pointerdown but not on a press inside it', () => {
    vi.stubGlobal('fetch', fetchStub());
    const onCloseDrawer = vi.fn();
    renderSidebar({ drawerOpen: true, onCloseDrawer });

    // jsdom runs no layout, so the dialog reports an empty box unless stubbed; give it one here,
    // the same way Drawer.test.tsx does, so a point outside it reads as the backdrop.
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));

    fireEvent.pointerDown(dialog, { clientX: 200, clientY: 300 });
    expect(onCloseDrawer).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { clientX: 500, clientY: 300 });
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

  it('changes the collapse glyph direction', () => {
    vi.stubGlobal('fetch', fetchStub());
    const { rerender } = renderSidebar({ collapsed: false });

    const expandedToggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    const expandedPaths = expandedToggle.querySelectorAll('path');
    expect(expandedPaths[expandedPaths.length - 1]).toHaveAttribute('d', 'M11 6.5L9 8L11 9.5');

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

    const collapsedToggle = screen.getByRole('button', { name: 'Expand sidebar' });
    const collapsedPaths = collapsedToggle.querySelectorAll('path');
    expect(collapsedPaths[collapsedPaths.length - 1]).toHaveAttribute('d', 'M9 6.5L11 8L9 9.5');
  });

  it('keeps every nav link reachable when collapsed, since the rail only hides the text', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ collapsed: true });

    // The labels are hidden with CSS, so the accessible name still resolves — a collapsed rail
    // must not cost a screen-reader user the navigation.
    expect(screen.getByRole('link', { name: 'Ledger' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveClass('sidebar--collapsed');
  });

  it('renders no title attribute on nav links', () => {
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Ledger' })).not.toHaveAttribute('title');
  });

  it('shows a tooltip on focus for a rail link when collapsed', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchStub());
    renderSidebar({ collapsed: true });

    const link = screen.getByRole('link', { name: 'Ledger' });
    link.focus();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Ledger');
    expect(link).toHaveAttribute('aria-describedby', tooltip.id);
  });

  it('folds the Adjudication and Measures counts into their link names', async () => {
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 3, approvalsCount: 0, measuresCount: 2 }));
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: 'Adjudication, 3 pending' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Measures, 2 pending' })).toBeInTheDocument();
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
