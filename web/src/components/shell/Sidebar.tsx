import type { ReactElement } from 'react';
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
  IconPanelLeft,
  IconTag,
  IconUsers,
} from '../icons';
import { usePendingCounts, type PendingCounts } from '../../lib/use-pending-counts';
import Dialog from '../ui/Dialog';
import IconButton from '../ui/IconButton';

interface NavItem {
  to: string;
  label: string;
  icon: ReactElement;
  end?: boolean;
  // A pending-item count for the Adjudication and Measures queue badges. `null`/`undefined` and
  // `0` all render no badge — a count is decoration, never a claim there is nothing to see.
  count?: number | null;
}

interface NavGroup {
  heading?: string;
  items: NavItem[];
}

/** Flat `to` → `label` pairs for the twelve destinations across the sidebar's seven areas,
 * independent of the icon/grouping shape below — the topbar breadcrumb fallback looks a route up
 * here rather than re-deriving it from `buildNavGroups`, which also carries an `isAdmin`-gated
 * shape and rendered icon elements it has no use for. */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: App.tsx's breadcrumb fallback and this file's own nav-group builder both read it
export const NAV_LABELS: { to: string; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/sources', label: 'Sources' },
  { to: '/documents', label: 'Data room' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/measures', label: 'Measures queue' },
  { to: '/canonical-entities', label: 'Aliases and entities' },
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
          label: 'Measures queue',
          icon: <IconCheck />,
          count: counts.measures,
        },
        ...(isAdmin
          ? [{ to: '/canonical-entities', label: 'Aliases and entities', icon: <IconTag /> }]
          : []),
      ],
    },
    {
      items: [
        {
          to: '/adjudication',
          label: 'Adjudication',
          icon: <IconAlertTriangle />,
          count: adjudicationCount,
        },
      ],
    },
    {
      items: [{ to: '/answers', label: 'Answers', icon: <IconMessageCircle /> }],
    },
    {
      items: [{ to: '/workflow-runs', label: 'Runs', icon: <IconActivity /> }],
    },
    {
      heading: isAdmin ? 'Admin' : undefined,
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
 * `onNavigate` is only supplied by the drawer, which needs each link click to close it. */
function NavGroups({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  return (
    <>
      {groups.map((group, index) => (
        <div className="sidebar-group" key={group.heading ?? `group-${index}`}>
          {group.heading && <h2 className="sidebar-heading micro-label">{group.heading}</h2>}
          <ul className="sidebar-list">
            {group.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  aria-label={navItemAriaLabel(item)}
                  title={item.label}
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
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

interface SidebarProps {
  isAdmin: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** The primary navigation landmark, plus the same nav content re-rendered inside a `Dialog` for
 * the sub-768px drawer — one nav-group source, two presentations, so the two never drift apart.
 *
 * `collapsed` narrows the persistent sidebar to an icon rail. It only has an effect at 1024px and
 * up; below that the breakpoints in shell.css already impose the rail, then the drawer.
 *
 * Fetches its own Adjudication and Measures queue badge counts via `usePendingCounts()`, the same
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

  return (
    <>
      <nav className={collapsed ? 'sidebar sidebar--collapsed' : 'sidebar'} aria-label="Primary">
        <div className="sidebar-top">
          <span className="sidebar-brand" aria-label="Evidence Ops">
            <span className="brand-mark" aria-hidden="true" />
            <span className="sidebar-brand-label">Evidence Ops</span>
          </span>
          <IconButton
            icon={<IconPanelLeft />}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            variant="ghost"
            size="sm"
            className="sidebar-collapse-toggle"
            onClick={onToggleCollapsed}
          />
        </div>
        <NavGroups groups={groups} />
      </nav>
      <div className="sidebar-drawer">
        <Dialog open={drawerOpen} onClose={onCloseDrawer} title="Navigation">
          <div className="sidebar-drawer-nav">
            <NavGroups groups={groups} onNavigate={onCloseDrawer} />
          </div>
        </Dialog>
      </div>
    </>
  );
}
