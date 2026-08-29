import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../lib/auth';
import { useBreadcrumbs } from '../../lib/breadcrumbs';
import { formatRelativeTimestamp } from '../../lib/format-timestamp';
import Topbar from './Topbar';

/** Publishes a fixed three-level trail for the duration it is mounted — stands in for a page that
 * has adopted `useBreadcrumbs`. */
function TrailPublisher() {
  useBreadcrumbs([
    { label: 'Evidence' },
    { label: 'Sources', to: '/sources' },
    { label: 'Acme Tower' },
  ]);
  return null;
}

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
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={onOpenMenu} onLogout={onLogout} />);

    expect(screen.getByText('Sources')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onOpenMenu).toHaveBeenCalledOnce();
  });

  it('shows the account trigger as "Account" while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  it('shows email, role and member-since as informational items beside a real Logout action', async () => {
    mockAuthedSession();
    const onLogout = vi.fn();
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={onLogout} />);

    const trigger = await screen.findByRole('button', { name: 'user@example.com' });
    fireEvent.click(trigger);

    const emailItem = screen.getByRole('menuitem', { name: 'user@example.com' });
    const roleItem = screen.getByRole('menuitem', { name: 'Member' });
    const memberSinceItem = screen.getByRole('menuitem', {
      name: `Member since ${formatRelativeTimestamp(ME.createdAt)}`,
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
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

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

  it('renders the fallback as a single current-page crumb inside a Breadcrumb nav', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const crumb = within(nav).getByText('Sources');
    expect(crumb).toHaveAttribute('aria-current', 'page');
    expect(crumb.closest('ol')).toBeInTheDocument();
  });

  it('renders a published trail as ordered crumbs, none of them past three levels, only the last carrying aria-current', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    // Topbar first, matching App.tsx's own document order (the chrome mounts ahead of the routed
    // page it composes with): Topbar's subscribe effect needs to run before TrailPublisher's
    // publish effect, or it misses the initial publish and never catches up. MemoryRouter is
    // needed here (unlike the other Topbar tests): the middle crumb below renders as a real
    // `<Link>`, which requires router context to exist at all.
    render(
      <MemoryRouter>
        <Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />
        <TrailPublisher />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    // Three crumbs reach the accessibility tree; the fourth list item — the collapsed-crumb
    // ellipsis marker `.breadcrumb-collapse` hides at <=560px and `.breadcrumb-ellipsis` shows in
    // its place — carries `aria-hidden` and so is excluded from a role query, though it is present
    // in the markup at every width (CSS decides which of the two a given viewport renders).
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3);
    expect(within(nav).getByText('…')).toBeInTheDocument();

    expect(within(nav).getByText('Evidence')).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Sources' })).toBeInTheDocument();
    const current = within(nav).getByText('Acme Tower');
    expect(current).toHaveAttribute('aria-current', 'page');
    // The Section crumb is never a link, even though it is not the current page.
    expect(within(nav).queryByRole('link', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('shows no persistent identity while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    expect(screen.queryByText('user@example.com')).not.toBeInTheDocument();
  });

  it('shows a persistent email and role badge for a signed-in visitor', async () => {
    mockAuthedSession();
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    // "Member" only ever renders as part of the persistent identity block while the account menu
    // is closed (the dropdown holding the same word as a menuitem is not in the tree yet), so its
    // presence alone proves the block rendered.
    expect(await screen.findByText('Member')).toBeInTheDocument();
    // The email now appears twice: the account menu trigger's sr-only accessible name, and this
    // block's visible copy.
    expect(screen.getAllByText('user@example.com')).toHaveLength(2);
  });
});
