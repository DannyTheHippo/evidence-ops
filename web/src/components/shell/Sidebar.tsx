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
  IconSearch,
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
  // A pending-item count for the Review queue and Organisation badges. `null`/`undefined` and `0`
  // all render no badge — a count is decoration, never a claim there is nothing to see.
  count?: number | null;
}

interface NavGroup {
  heading?: string;
  items: NavItem[];
}

/** Flat `to` → `label` pairs for every nav destination, independent of the icon/grouping shape
 * below — the topbar breadcrumb fallback looks a route up here rather than re-deriving it from
 * `buildNavGroups`, which also carries an `isAdmin`-gated shape and rendered icon elements it has
 * no use for. */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: App.tsx's breadcrumb fallback and this file's own nav-group builder both read it
export const NAV_LABELS: { to: string; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/ask', label: 'Ask' },
  { to: '/answers', label: 'Answers' },
  { to: '/search', label: 'Search' },
  { to: '/documents', label: 'Data Room' },
  { to: '/sources', label: 'Sources' },
  { to: '/conflicts', label: 'Conflicts' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/workflow-runs', label: 'Runs' },
  { to: '/people', label: 'People' },
  { to: '/canonical-entities', label: 'Canonical Entities' },
  { to: '/audit-events', label: 'Audit Log' },
  { to: '/api-keys', label: 'API Keys' },
];

function buildNavGroups(isAdmin: boolean, counts: PendingCounts): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [{ to: '/', label: 'Home', icon: <IconHome />, end: true }],
    },
    {
      heading: 'Ask',
      items: [
        { to: '/ask', label: 'Ask', icon: <IconMessageCircle /> },
        { to: '/answers', label: 'Answers', icon: <IconFileText /> },
      ],
    },
    {
      heading: 'Evidence',
      items: [
        { to: '/search', label: 'Search', icon: <IconSearch /> },
        { to: '/documents', label: 'Data Room', icon: <IconFolder /> },
        { to: '/sources', label: 'Sources', icon: <IconDatabase /> },
      ],
    },
    {
      heading: 'Review queue',
      items: [
        {
          to: '/conflicts',
          label: 'Conflicts',
          icon: <IconAlertTriangle />,
          count: counts.conflicts,
        },
        {
          to: '/approvals',
          label: 'Approvals',
          icon: <IconCheck />,
          count: counts.approvals,
        },
        { to: '/workflow-runs', label: 'Runs', icon: <IconActivity /> },
      ],
    },
  ];

  if (isAdmin) {
    groups.push({
      heading: 'Organisation',
      items: [
        { to: '/people', label: 'People', icon: <IconUsers /> },
        // No badge: no endpoint exposes a count of pending harvested-alias proposals without
        // fetching every canonical entity's alias list, which the badge contract forbids.
        { to: '/canonical-entities', label: 'Canonical Entities', icon: <IconTag /> },
        { to: '/audit-events', label: 'Audit Log', icon: <IconClipboard /> },
      ],
    });
  }

  groups.push({
    heading: 'Account',
    items: [{ to: '/api-keys', label: 'API Keys', icon: <IconKey /> }],
  });

  return groups;
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
          {group.heading && <h2 className="sidebar-heading">{group.heading}</h2>}
          <ul className="sidebar-list">
            {group.items.map((item) => (
              <li key={item.to}>
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
                        · {item.count}
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
 * Fetches its own Review queue badge counts via `usePendingCounts()`, the same self-contained
 * pattern `Topbar` uses for `useSession()` — `App.tsx` composes this component without passing
 * count data down. */
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
