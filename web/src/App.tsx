import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar, { NAV_LABELS } from './components/shell/Sidebar';
import Topbar from './components/shell/Topbar';
import Toaster from './components/ui/Toaster';
import { useBreadcrumbTrail } from './lib/breadcrumbs';
import { useSession } from './lib/use-session';
import InvitePage from './pages/InvitePage';
import LoginPage from './pages/LoginPage';

/** The nearest nav destination that owns `pathname` — an exact match first, then the longest nav
 * `to` that prefixes it, so a detail route like `/sources/:id` breadcrumbs to "Sources" rather
 * than falling back to the brand. */
const SIDEBAR_STORAGE_KEY = 'evidence-ops-sidebar-collapsed';

// Layout preference: fails OPEN. Any storage error (disabled storage, quota, privacy mode) leaves
// the sidebar expanded rather than blocking render — the nav is reachable either way.
function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function breadcrumbFor(pathname: string): string {
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
  // sees a link to a page RequireAdmin would immediately bounce them off of.
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

  // breadcrumbFor falls back to the brand for a route outside NAV_LABELS — /login and /invite,
  // which have no nav destination. Memoized so its identity only changes with the pathname: it
  // feeds `useBreadcrumbTrail` as the fallback trail, and a fresh array literal on every render
  // would otherwise re-fire the title effect below on every unrelated App re-render.
  const fallbackLabel = breadcrumbFor(location.pathname);
  const fallbackTrail = useMemo(() => [{ label: fallbackLabel }], [fallbackLabel]);
  // The one source `document.title` and the topbar's breadcrumb nav both read: whichever page
  // most recently called `useBreadcrumbs` publishes here, or the route-derived fallback while
  // none has.
  const trail = useBreadcrumbTrail(fallbackTrail);

  useEffect(() => {
    const label = trail.at(-1)?.label ?? fallbackLabel;
    // Qualifying the brand's own title would render "Evidence Ops · Evidence Ops".
    document.title = label === 'Evidence Ops' ? label : `${label} · Evidence Ops`;
  }, [trail, fallbackLabel]);

  useEffect(() => {
    if (previousPathname.current === location.pathname) return;
    previousPathname.current = location.pathname;
    mainRef.current?.focus();
    // `#main-content` carries `.container`'s `overflow-y: auto` and is the element that actually
    // scrolls — `body` is `overflow: hidden` under a `100vh` root, so the document scrolling element
    // never moves and `window.scrollTo` would do nothing. Focusing the container scrolls its
    // ancestors to reveal it; it does not reset the container's own offset, so this is separate.
    // Assigning `scrollTop` rather than calling `scrollTo`: the property is what jsdom implements,
    // so the reset stays assertable in a test.
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [location.pathname]);

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
      await navigate('/login');
    }
  }

  // Chrome visibility only, not an authorization check — RequireAuth on each route is the actual
  // gate. Route-based rather than session-based: an App-level probe would only run once on mount
  // (empty dep array) and would not notice a login that happens after that first render.
  const showChrome = location.pathname !== '/login' && location.pathname !== '/invite';

  const routes = (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      {/* No fallback UI: an authed visitor already saw RequireAuth's own null loading state
          (nothing renders) on the same page, so rendering nothing here continues that same
          sequence instead of swapping in a differently-shaped placeholder.
          ErrorBoundary sits outside Suspense: a lazy import() that rejects (a stale deploy
          requesting a chunk a newer build removed) propagates as a render error on resolution,
          and only an ancestor of Suspense — never a descendant — catches that. */}
      <Route
        path="/*"
        element={
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={null}>
              <AuthenticatedRoutes />
            </Suspense>
          </ErrorBoundary>
        }
      />
    </Routes>
  );

  return (
    <>
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
      ) : (
        <main id="main-content" tabIndex={-1} className="container" ref={mainRef}>
          {routes}
        </main>
      )}
      <Toaster />
    </>
  );
}
