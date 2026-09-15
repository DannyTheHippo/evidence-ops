import { useSyncExternalStore, type ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconClipboard,
  IconDatabase,
  IconFileText,
  IconFolder,
  IconHome,
  IconKey,
  IconMessageCircle,
  IconPanelLeftClose,
  IconPanelLeftOpen,
  IconTag,
  IconUsers,
} from '../icons';
import { usePendingCounts, type PendingCounts } from '../../lib/use-pending-counts';
import Drawer from '../ui/Drawer';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';

interface NavItem {
  to: string;
  label: string;
  icon: ReactElement;
  end?: boolean;
  // A pending-item count for the Adjudication and Measures badges. `null`/`undefined` and `0` all
  // render no badge — a count is decoration, never a claim there is nothing to see.
  count?: number | null;
}

interface NavGroup {
  heading?: string;
  items: NavItem[];
}

/** Flat `to` → `label` pairs for the twelve destinations across the sidebar's five groups,
 * independent of the icon/grouping shape below — the topbar breadcrumb fallback looks a route up
 * here rather than re-deriving it from `buildNavGroups`, which also carries an `isAdmin`-gated
 * shape and rendered icon elements it has no use for. */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: App.tsx's breadcrumb fallback and this file's own nav-group builder both read it
export const NAV_LABELS: { to: string; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/sources', label: 'Sources' },
  { to: '/documents', label: 'Data room' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/measures', label: 'Measures' },
  { to: '/canonical-entities', label: 'Entities' },
  { to: '/adjudication', label: 'Adjudication' },
  { to: '/answers', label: 'Answers' },
  { to: '/workflow-runs', label: 'Runs' },
  { to: '/people', label: 'People' },
  { to: '/audit-events', label: 'Audit events' },
  { to: '/api-keys', label: 'API keys' },
];

function buildNavGroups(isAdmin: boolean, counts: PendingCounts): NavGroup[] {
  // null only once both fetches have failed — one surviving count still reports a real, if
  // partial, total rather than hiding the badge outright.
  const adjudicationCount =
    counts.conflicts === null && counts.approvals === null
      ? null
      : (counts.conflicts ?? 0) + (counts.approvals ?? 0);

  return [
    {
      items: [{ to: '/', label: 'Home', icon: <IconHome />, end: true }],
    },
    {
      heading: 'Estate',
      items: [
        { to: '/sources', label: 'Sources', icon: <IconDatabase /> },
        { to: '/documents', label: 'Data room', icon: <IconFolder /> },
      ],
    },
    {
      heading: 'Ledger',
      items: [
        { to: '/ledger', label: 'Ledger', icon: <IconFileText /> },
        {
          to: '/measures',
          label: 'Measures',
          icon: <IconCheck />,
          count: counts.measures,
        },
        ...(isAdmin ? [{ to: '/canonical-entities', label: 'Entities', icon: <IconTag /> }] : []),
      ],
    },
    {
      heading: 'Work',
      items: [
        {
          to: '/adjudication',
          label: 'Adjudication',
          icon: <IconAlertTriangle />,
          count: adjudicationCount,
        },
        { to: '/answers', label: 'Answers', icon: <IconMessageCircle /> },
        { to: '/workflow-runs', label: 'Runs', icon: <IconActivity /> },
      ],
    },
    {
      heading: 'Admin',
      items: [
        ...(isAdmin
          ? [
              { to: '/people', label: 'People', icon: <IconUsers /> },
              { to: '/audit-events', label: 'Audit events', icon: <IconClipboard /> },
            ]
          : []),
        { to: '/api-keys', label: 'API keys', icon: <IconKey /> },
      ],
    },
  ];
}

function sidebarLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'sidebar-link is-active' : 'sidebar-link';
}

function navItemAriaLabel(item: NavItem): string {
  return item.count ? `${item.label}, ${item.count} pending` : item.label;
}

/** Renders the group headings and nav links shared by the persistent sidebar and the drawer.
 * `onNavigate` is only supplied by the drawer, which needs each link click to close it. `isRail`
 * is only ever `true` for the persistent sidebar — the drawer is never a rail — and swaps each
 * link's accessible name from a permanent `title=` attribute to a `Tooltip` shown on hover or
 * focus, which a rail's icon-only width still needs to disclose the label. A group's heading is a
 * labelled `<div>`, not an `<h2>` — the sidebar's own group structure is not part of the page's
 * heading outline, which starts at the routed page's `<h1>`. */
function NavGroups({
  groups,
  onNavigate,
  isRail = false,
}: {
  groups: NavGroup[];
  onNavigate?: () => void;
  isRail?: boolean;
}) {
  return (
    <>
      {groups.map((group, index) => {
        const headingId = group.heading ? `nav-group-${index}` : undefined;
        return (
          <div className="sidebar-group" key={group.heading ?? `group-${index}`}>
            {group.heading && (
              <div className="sidebar-heading micro-label" id={headingId}>
                {group.heading}
              </div>
            )}
            <ul className="sidebar-list" aria-labelledby={headingId}>
              {group.items.map((item) => (
                <li key={item.to}>
                  <Tooltip content={isRail ? item.label : null}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      aria-label={navItemAriaLabel(item)}
                      className={sidebarLinkClassName}
                      onClick={onNavigate}
                    >
                      {item.icon}
                      <span className="sidebar-label">{item.label}</span>
                      {!!item.count && (
                        <>
                          <span className="nav-count" aria-hidden="true">
                            {item.count}
                          </span>
                          <span className="nav-count-dot" aria-hidden="true" />
                        </>
                      )}
                    </NavLink>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

const RAIL_QUERY = '(max-width: 1023px)';

function subscribeRailImposed(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(RAIL_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getRailImposedSnapshot(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(RAIL_QUERY).matches;
}

/** Whether the sub-1024px breakpoint already imposes the icon rail in `shell.css`, independent of
 * the manual `collapsed` toggle. jsdom carries no `matchMedia`, so the snapshot fails open to
 * `false` (the expanded shape) rather than throwing. */
function useRailImposed(): boolean {
  return useSyncExternalStore(subscribeRailImposed, getRailImposedSnapshot);
}

interface SidebarProps {
  isAdmin: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** The primary navigation landmark, plus the same nav content re-rendered inside a `Drawer` for
 * the sub-768px drawer — one nav-group source, two presentations, so the two never drift apart.
 * Renders five groups (Home, Estate, Ledger, Work, Admin); Admin narrows to API keys only for a
 * member.
 *
 * `collapsed` narrows the persistent sidebar to an icon rail. It only has an effect at 1024px and
 * up; below that the breakpoints in shell.css already impose the rail, then the drawer — reflected
 * here by `useRailImposed()`, so a link's tooltip and dropped `title=` follow whichever cause
 * produced the rail.
 *
 * Fetches its own Adjudication and Measures badge counts via `usePendingCounts()`, the same
 * self-contained pattern `Topbar` uses for `useSession()` — `App.tsx` composes this component
 * without passing count data down. */
export default function Sidebar({
  isAdmin,
  drawerOpen,
  onCloseDrawer,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const counts = usePendingCounts();
  const groups = buildNavGroups(isAdmin, counts);
  const railImposed = useRailImposed();
  const isRail = collapsed || railImposed;

  return (
    <>
      <nav className={collapsed ? 'sidebar sidebar--collapsed' : 'sidebar'} aria-label="Primary">
        <div className="sidebar-top">
          <span className="sidebar-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="sidebar-brand-label">Evidence Ops</span>
          </span>
          <IconButton
            icon={collapsed ? <IconPanelLeftOpen /> : <IconPanelLeftClose />}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            variant="ghost"
            size="sm"
            className="sidebar-collapse-toggle"
            onClick={onToggleCollapsed}
          />
        </div>
        <NavGroups groups={groups} isRail={isRail} />
      </nav>
      <Drawer
        open={drawerOpen}
        onClose={onCloseDrawer}
        title="Navigation"
        side="start"
        size="sm"
        closeOnWiden
      >
        <nav aria-label="Primary" className="sidebar-drawer-nav">
          <NavGroups groups={groups} onNavigate={onCloseDrawer} />
        </nav>
      </Drawer>
    </>
  );
}
