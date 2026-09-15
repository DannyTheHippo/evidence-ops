import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar, { NAV_LABELS } from './components/shell/Sidebar';
import Topbar from './components/shell/Topbar';
import Announcer from './components/ui/Announcer';
import Skeleton from './components/ui/Skeleton';
import Toaster from './components/ui/Toaster';
import { clearToasts } from './components/ui/toast';
import { announce, subscribeAnnouncements, unsubscribeAnnouncements } from './lib/announce';
import { useBreadcrumbTrail } from './lib/breadcrumbs';
import { useSession } from './lib/use-session';
import InvitePage from './pages/InvitePage';
import LoginPage from './pages/LoginPage';

const SIDEBAR_STORAGE_KEY = 'evidence-ops-sidebar-collapsed';

// The two anonymous pages and the /invitations redirect shim carry no nav destination, so
// breadcrumbFor consults this before NAV_LABELS.
const SHELL_TITLES: Record<string, string> = {
  '/login': 'Sign in',
  '/invite': 'Join your team',
  '/invitations': 'People',
};

// Layout preference: fails OPEN. Any storage error (disabled storage, quota, privacy mode) leaves
// the sidebar expanded rather than blocking render — the nav is reachable either way.
function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** The nearest nav destination that owns `pathname` — `SHELL_TITLES` first for the routes with no
 * nav destination, then an exact `NAV_LABELS` match, then the longest nav `to` that prefixes it,
 * so a detail route like `/sources/:id` breadcrumbs to "Sources" rather than falling back to the
 * brand. */
function breadcrumbFor(pathname: string): string {
  const shellTitle = SHELL_TITLES[pathname];
  if (shellTitle) return shellTitle;

  const exact = NAV_LABELS.find((item) => item.to === pathname);
  if (exact) return exact.label;

  const prefixMatch = NAV_LABELS.filter(
    (item) => item.to !== '/' && pathname.startsWith(`${item.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];

  return prefixMatch?.label ?? 'Evidence Ops';
}

// Everything reachable only after RequireAuth/RequireAdmin passes, loaded behind a single
// Suspense boundary rather than statically — an anonymous visitor hitting /login never downloads
// it. One lazy() call against one statically-imported module (AuthenticatedRoutes.tsx) rather
// than one dynamic import per page: a visitor who is already authenticated fetches one chunk once
// and then navigates the app with no further per-route loading state.
const AuthenticatedRoutes = lazy(() => import('./AuthenticatedRoutes'));

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  // Same "don't show a control that fails" principle as RequireAdmin itself — a member never
  // sees a link to a page RequireAdmin would render as a 403 view instead.
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readStoredCollapsed());
  const mainRef = useRef<HTMLElement | null>(null);
  // Seeded with the mount-time pathname rather than left empty, so the comparison below treats
  // the render that mounts App as "no change yet" and never yanks focus from wherever the
  // browser already put it (an autofocused field, the URL bar). It also makes StrictMode's
  // post-mount double effect run a no-op: both invocations see the same pathname, so only a real
  // navigation — where the dependency has actually changed since the ref was last written — moves
  // focus. #main-content is rendered by App unconditionally, never inside the AuthenticatedRoutes
  // Suspense boundary, so this effect never races the lazy chunk resolving.
  const previousPathname = useRef(location.pathname);

  // breadcrumbFor resolves /login, /invite and /invitations through SHELL_TITLES and falls back
  // to the brand only for a route outside both that and NAV_LABELS. Memoized so its identity only
  // changes with the pathname: it feeds `useBreadcrumbTrail` as the fallback trail, and a fresh
  // array literal on every render would otherwise re-fire the title effect below on every
  // unrelated App re-render.
  const fallbackLabel = breadcrumbFor(location.pathname);
  const fallbackTrail = useMemo(() => [{ label: fallbackLabel }], [fallbackLabel]);
  // The one source `document.title` and the topbar's breadcrumb nav both read: whichever page
  // most recently called `useBreadcrumbs` publishes here, or the route-derived fallback while
  // none has.
  const trail = useBreadcrumbTrail(fallbackTrail);

  useEffect(() => {
    // The last two crumbs read as "Record · Page"; a one-crumb trail (a list page, or the
    // brand-only fallback) reads as just that label. Qualifying the brand's own title would
    // render "Evidence Ops · Evidence Ops".
    const labels = [...trail]
      .slice(-2)
      .reverse()
      .map((crumb) => crumb.label);
    document.title =
      labels.length === 1 && labels[0] === 'Evidence Ops'
        ? labels[0]
        : `${labels.join(' · ')} · Evidence Ops`;
  }, [trail]);

  useEffect(() => {
    if (previousPathname.current === location.pathname) return;
    previousPathname.current = location.pathname;
    // Focus lands on the page's own <h1> so a screen reader announces the destination, not just
    // "main"; a page without one (still loading, or a view with no heading) falls back to the
    // container itself.
    const heading = mainRef.current?.querySelector<HTMLElement>('h1');
    (heading ?? mainRef.current)?.focus();
    // `#main-content` carries `.container`'s `overflow-y: auto` and is the element that actually
    // scrolls — `body` is `overflow: hidden` under a `100vh` root, so the document scrolling element
    // never moves and `window.scrollTo` would do nothing. Focusing the container scrolls its
    // ancestors to reveal it; it does not reset the container's own offset, so this is separate.
    // Assigning `scrollTop` rather than calling `scrollTo`: the property is what jsdom implements,
    // so the reset stays assertable in a test.
    if (mainRef.current) mainRef.current.scrollTop = 0;
    // fallbackLabel is the route-derived label at this moment, not the later-published trail — a
    // detail page whose trail changes once its data loads still announces exactly once per
    // navigation.
    announce(fallbackLabel);
  }, [location.pathname, fallbackLabel]);

  // Derived outside the setState updater deliberately: StrictMode double-invokes updaters, so a
  // write placed inside one runs twice per click.
  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // storage unavailable — the toggle still applies for this session, just not the next
    }
  }

  async function handleLogout() {
    // Client-side logout must not depend on the server's answer: logout() already clears the
    // local session cache unconditionally (its own try/finally), so a rejected request (a CSRF
    // 403, a 500, a dropped connection) has nothing left to do here but not crash the click
    // handler — onClick={() => void handleLogout()} discards this function's return value, so an
    // uncaught rejection would otherwise surface as an unhandled promise rejection instead of
    // just navigating the user out.
    try {
      await logout();
    } catch {
      // Already handled: logout()'s own finally cleared the session regardless of this failure.
    } finally {
      // A toast from the session that just ended must not follow the visitor onto /login.
      clearToasts();
      await navigate('/login');
    }
  }

  // isChromeRoute is route-based, not an authorization check — RequireAuth on each route is the
  // actual gate. showChrome additionally requires an authed session, so the shell never flashes
  // around a still-loading or anonymous visitor; both stay reactive to useSession() itself rather
  // than a one-shot probe, so a client-side login or logout updates them without a reload.
  const isChromeRoute = location.pathname !== '/login' && location.pathname !== '/invite';
  const showChrome = isChromeRoute && session.status === 'authed';

  const loadingView = (
    <div className="view" aria-busy="true">
      <Skeleton label="Loading page…" />
    </div>
  );

  const routes = (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      {/* The skeleton fallback covers the gap between AuthenticatedRoutes' lazy chunk resolving
          and RequireAuth's own render, so a first authenticated navigation shows a placeholder
          instead of a blank pause.
          ErrorBoundary sits outside Suspense: a lazy import() that rejects (a stale deploy
          requesting a chunk a newer build removed) propagates as a render error on resolution,
          and only an ancestor of Suspense — never a descendant — catches that. */}
      <Route
        path="/*"
        element={
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={loadingView}>
              <AuthenticatedRoutes />
            </Suspense>
          </ErrorBoundary>
        }
      />
    </Routes>
  );

  return (
    <ErrorBoundary scope="app" resetKey={location.pathname}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {showChrome ? (
        <div className="shell">
          <Sidebar
            isAdmin={isAdmin}
            drawerOpen={drawerOpen}
            onCloseDrawer={() => setDrawerOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
          />
          <div className="shell-main">
            <Topbar
              breadcrumbFallback={fallbackLabel}
              onOpenMenu={() => setDrawerOpen(true)}
              onLogout={() => void handleLogout()}
            />
            <main id="main-content" tabIndex={-1} className="container" ref={mainRef}>
              {routes}
            </main>
          </div>
        </div>
      ) : isChromeRoute && session.status === 'loading' ? (
        <main id="main-content" tabIndex={-1} className="container" ref={mainRef}>
          {loadingView}
        </main>
      ) : (
        <main id="main-content" tabIndex={-1} className="container" ref={mainRef}>
          {routes}
        </main>
      )}
      <Toaster />
      <Announcer subscribe={subscribeAnnouncements} unsubscribe={unsubscribeAnnouncements} />
    </ErrorBoundary>
  );
}
