/// <reference types="vite/client" />
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../lib/auth';
import { useBreadcrumbs } from '../../lib/breadcrumbs';
import primitivesCss from '../../styles/primitives.css?raw';
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

/** Publishes a two-level trail whose first (and only non-current) crumb carries a route — stands
 * in for the common "Section > current record" case, where that crumb should render as a link. */
function TwoLevelPublisher() {
  useBreadcrumbs([{ label: 'Answers', to: '/answers' }, { label: 'What is the cap rate?' }]);
  return null;
}

/** Publishes a single, implausibly long current-page crumb, to exercise `.breadcrumb-current`'s
 * truncation. */
function LongCrumbPublisher() {
  useBreadcrumbs([{ label: 'x'.repeat(200) }]);
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

  it('names the trigger with email and role and offers Logout as the only item', async () => {
    mockAuthedSession();
    const onLogout = vi.fn();
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={onLogout} />);

    const trigger = await screen.findByRole('button', { name: 'user@example.com, Member' });
    fireEvent.click(trigger);

    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });
    expect(logoutItem).not.toHaveAttribute('aria-disabled');
    fireEvent.click(logoutItem);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('opens the account menu on click, closes on Escape and returns focus to the trigger', async () => {
    mockAuthedSession();
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    const trigger = await screen.findByRole('button', { name: 'user@example.com, Member' });
    trigger.focus();
    fireEvent.click(trigger);

    const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });
    expect(logoutItem).toHaveFocus();

    fireEvent.keyDown(logoutItem, { key: 'Escape' });

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
    expect(current).toHaveClass('breadcrumb-current');
    // "Evidence" carries no `to` in this fixture, so it stays plain text — not because it is
    // the first crumb.
    expect(within(nav).queryByRole('link', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('links a non-last crumb that carries a route, including the first, and marks the last as the current page', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />
        <TwoLevelPublisher />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Answers' })).toBeInTheDocument();
    const current = within(nav).getByText('What is the cap rate?');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders separators that are hidden from assistive tech', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <MemoryRouter>
        <Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />
        <TrailPublisher />
      </MemoryRouter>,
    );

    const separators = container.querySelectorAll('.breadcrumb-sep');
    expect(separators.length).toBeGreaterThan(0);
    separators.forEach((separator) => expect(separator).toHaveAttribute('aria-hidden', 'true'));
  });

  it('truncates a very long current crumb without displacing the account control', async () => {
    mockAuthedSession();
    render(
      <MemoryRouter>
        <Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />
        <LongCrumbPublisher />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const current = within(nav).getByText('x'.repeat(200));
    expect(current).toHaveClass('breadcrumb-current');
    expect(
      await screen.findByRole('button', { name: 'user@example.com, Member' }),
    ).toBeInTheDocument();
  });

  it('shows no persistent identity while the session probe is pending', () => {
    vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    expect(screen.queryByText('user@example.com')).not.toBeInTheDocument();
  });

  it('shows a persistent email and role badge for a signed-in visitor', async () => {
    mockAuthedSession();
    render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);

    // "Member" renders once, inside the persistent identity block's Badge — the trigger's own
    // sr-only name carries the role too, but as part of the single compound "email, role" string,
    // not as an exact-text match of "Member" alone.
    expect(await screen.findByText('Member')).toBeInTheDocument();
    // Likewise the plain "user@example.com" text matches only the identity block's visible copy;
    // the trigger's sr-only name is the compound "user@example.com, Member" string.
    expect(screen.getAllByText('user@example.com')).toHaveLength(1);
  });

  // Both menus sit at the topbar's end edge, so a surface growing from the trigger's start edge
  // runs past the viewport. jsdom has no layout, so the stylesheet is loaded and the placement is
  // read from the computed style of the surface — against its `.menu` container where CSS anchor
  // positioning is supported, or against a stubbed `getBoundingClientRect` where it is not.
  describe('menu placement at the end edge', () => {
    const originalShow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
    const originalHide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover');
    let sheet: HTMLStyleElement;

    function restore(name: 'showPopover' | 'hidePopover', original?: PropertyDescriptor) {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, name, original);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>)[name];
      }
    }

    beforeEach(() => {
      sheet = document.createElement('style');
      sheet.textContent = primitivesCss;
      document.head.append(sheet);
      // A browser with the popover API: placement then depends on CSS anchor positioning support.
      Object.defineProperty(HTMLElement.prototype, 'showPopover', {
        configurable: true,
        value: vi.fn(),
      });
      Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
        configurable: true,
        value: vi.fn(),
      });
      vi.spyOn(auth, 'ensureSession').mockReturnValue(new Promise(() => {}));
    });

    afterEach(() => {
      sheet.remove();
      vi.unstubAllGlobals();
      restore('showPopover', originalShow);
      restore('hidePopover', originalHide);
    });

    const openSurface = (triggerName: string) => {
      render(<Topbar breadcrumbFallback="Sources" onOpenMenu={() => {}} onLogout={() => {}} />);
      const trigger = screen.getByRole('button', { name: triggerName });
      fireEvent.click(trigger);
      return document.getElementById(trigger.getAttribute('aria-controls')!)!;
    };

    it.each(['Account', 'Theme: System'])(
      'places the %s menu surface at the trigger end edge',
      (triggerName) => {
        vi.stubGlobal('CSS', { supports: () => true });

        expect(openSurface(triggerName)).toHaveClass('popover-surface--bottom-end');
      },
    );

    it.each(['Account', 'Theme: System'])(
      'pins the %s menu surface to the trigger end edge where CSS anchor positioning is unsupported',
      (triggerName) => {
        vi.stubGlobal('CSS', { supports: () => false });
        vi.stubGlobal('innerWidth', 1440);
        // jsdom has no layout engine, so every element's real rect is all zeros — stubbed here,
        // keyed on the surface's own class, the way Sidebar.test.tsx stubs its drawer box.
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
          this: Element,
        ) {
          return this.classList.contains('popover-surface')
            ? new DOMRect(0, 0, 200, 120)
            : new DOMRect(1300, 10, 80, 32);
        });

        const surface = openSurface(triggerName);

        expect(surface).not.toHaveAttribute('popover');
        const style = getComputedStyle(surface);
        expect(style.position).toBe('fixed');
        // Pinned to the trigger's own end edge: 1300 + 80 (trigger right) − 200 (surface width).
        expect(style.left).toBe('1180px');
      },
    );
  });
});
