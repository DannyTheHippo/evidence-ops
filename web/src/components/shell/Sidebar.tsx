import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import {
  IconActivity,
  IconAlertTriangle,
  IconBarChart,
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
  IconUserPlus,
} from '../icons';
import Dialog from '../ui/Dialog';
import IconButton from '../ui/IconButton';

interface NavItem {
  to: string;
  label: string;
  icon: ReactElement;
  end?: boolean;
}

interface NavGroup {
  heading?: string;
  items: NavItem[];
}

/** Flat `to` → `label` pairs for every nav destination, independent of the icon/grouping shape
 * above — the topbar breadcrumb looks a route up here rather than re-deriving it from
 * `buildNavGroups`, which also carries an `isAdmin`-gated shape and rendered icon elements it has
 * no use for. */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: App.tsx's breadcrumb lookup and this file's own nav-group builder both read it
export const NAV_LABELS: { to: string; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/measures', label: 'Measures' },
  { to: '/ask', label: 'Ask' },
  { to: '/answers', label: 'Answers' },
  { to: '/search', label: 'Search' },
  { to: '/documents', label: 'Data Room' },
  { to: '/sources', label: 'Sources' },
  { to: '/conflicts', label: 'Conflicts' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/workflow-runs', label: 'Runs' },
  { to: '/api-keys', label: 'API Keys' },
  { to: '/audit-events', label: 'Audit Log' },
  { to: '/invitations', label: 'Invitations' },
  { to: '/resolution-rules', label: 'Resolution Rules' },
  { to: '/canonical-entities', label: 'Canonical Entities' },
];

function buildNavGroups(isAdmin: boolean): NavGroup[] {
  return [
    {
      items: [
        { to: '/', label: 'Home', icon: <IconHome />, end: true },
        { to: '/measures', label: 'Measures', icon: <IconBarChart /> },
      ],
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
      heading: 'Review',
      items: [
        { to: '/conflicts', label: 'Conflicts', icon: <IconAlertTriangle /> },
        { to: '/approvals', label: 'Approvals', icon: <IconCheck /> },
        { to: '/workflow-runs', label: 'Runs', icon: <IconActivity /> },
      ],
    },
    {
      heading: 'Admin',
      items: [
        { to: '/api-keys', label: 'API Keys', icon: <IconKey /> },
        ...(isAdmin
          ? [
              { to: '/audit-events', label: 'Audit Log', icon: <IconClipboard /> },
              { to: '/invitations', label: 'Invitations', icon: <IconUserPlus /> },
              { to: '/resolution-rules', label: 'Resolution Rules', icon: <IconAlertTriangle /> },
              { to: '/canonical-entities', label: 'Canonical Entities', icon: <IconTag /> },
            ]
          : []),
      ],
    },
  ];
}

function sidebarLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'sidebar-link is-active' : 'sidebar-link';
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
                  aria-label={item.label}
                  className={sidebarLinkClassName}
                  onClick={onNavigate}
                >
                  {item.icon}
                  <span className="sidebar-label">{item.label}</span>
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
 * up; below that the breakpoints in shell.css already impose the rail, then the drawer. */
export default function Sidebar({
  isAdmin,
  drawerOpen,
  onCloseDrawer,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const groups = buildNavGroups(isAdmin);

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
      <Dialog open={drawerOpen} onClose={onCloseDrawer} title="Navigation">
        <div className="sidebar-drawer-nav">
          <NavGroups groups={groups} onNavigate={onCloseDrawer} />
        </div>
      </Dialog>
    </>
  );
}
