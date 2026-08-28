import { Link } from 'react-router-dom';
import { IconChevronDown, IconMenu } from '../icons';
import type { BreadcrumbItem } from '../../lib/breadcrumbs';
import { useBreadcrumbTrail } from '../../lib/breadcrumbs';
import { useSession } from '../../lib/use-session';
import Badge from '../ui/Badge';
import IconButton from '../ui/IconButton';
import Menu from '../ui/Menu';
import ConnectionStatus from './ConnectionStatus';
import { ThemeToggle } from './ThemeToggle';

interface TopbarProps {
  breadcrumbFallback: string;
  onOpenMenu: () => void;
  onLogout: () => void;
}

/** Renders `trail` as an ordered breadcrumb list, three levels at most (Section › Page ›
 * Record). The first crumb (the Section) is never a link, regardless of whether it carries a `to`
 * — a group label has nowhere of its own to go. The last crumb is always the current page:
 * plain text carrying `aria-current="page"`, never a link either. At ≤560px every crumb but the
 * last two collapses into a single non-interactive "…" (`.breadcrumb-collapse`,
 * `.breadcrumb-ellipsis` in shell.css). */
function BreadcrumbNav({ trail }: { trail: BreadcrumbItem[] }) {
  const collapsedCount = trail.length > 2 ? trail.length - 2 : 0;

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {collapsedCount > 0 && (
          <li className="breadcrumb-ellipsis" aria-hidden="true">
            …
          </li>
        )}
        {trail.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === trail.length - 1;
          const isLinkable = Boolean(item.to) && !isFirst && !isLast;

          return (
            <li
              key={`${item.label}-${index}`}
              className={index < collapsedCount ? 'breadcrumb-collapse' : undefined}
            >
              {isLast ? (
                <span aria-current="page">{item.label}</span>
              ) : isLinkable ? (
                <Link to={item.to as string}>{item.label}</Link>
              ) : (
                <span>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The chrome header above routed content: the drawer trigger (visible only below 768px, per
 * `.menu-toggle` in shell.css), the current page's breadcrumb trail, connection status, the
 * signed-in identity, theme control, and the account menu. Reads its own session via
 * `useSession()` — `App.tsx` composes this component without passing session data down, and the
 * hook's cache means this costs no extra probe beyond the one `App` already triggered.
 *
 * `breadcrumbFallback` is the single Page-level crumb `App.tsx` derives from the route; it is
 * what `useBreadcrumbTrail` returns while no page has published a trail of its own via
 * `useBreadcrumbs`. */
export default function Topbar({ breadcrumbFallback, onOpenMenu, onLogout }: TopbarProps) {
  const session = useSession();
  const me = session.status === 'authed' ? session.me : null;
  const accountLabel = me ? me.email : 'Account';
  const accountInitial = me ? me.email.charAt(0).toUpperCase() : '?';
  const roleLabel = me ? (me.role === 'admin' ? 'Admin' : 'Member') : null;
  const trail = useBreadcrumbTrail([{ label: breadcrumbFallback }]);

  const accountItems = me
    ? [
        { label: me.email },
        { label: roleLabel as string },
        { label: `Member since ${new Date(me.createdAt).toLocaleDateString()}` },
        { label: 'Logout', onSelect: onLogout },
      ]
    : [{ label: 'Logout', onSelect: onLogout }];

  return (
    <header className="topbar">
      <IconButton
        icon={<IconMenu />}
        aria-label="Open menu"
        variant="ghost"
        size="sm"
        className="menu-toggle"
        onClick={onOpenMenu}
      />
      <BreadcrumbNav trail={trail} />
      <div className="topbar-end">
        <ConnectionStatus />
        {/* The SPA never learns a tenant id, so this identity slot carries only email and role —
            there is no further tenant context to show alongside it. Hidden below 768px
            (`.topbar-identity` in shell.css), leaving the account menu's avatar trigger as the
            only surface. */}
        {me && (
          <span className="topbar-identity">
            <span className="topbar-identity-email">{me.email}</span>
            <Badge tone={me.role === 'admin' ? 'info' : 'neutral'}>{roleLabel}</Badge>
          </span>
        )}
        <ThemeToggle />
        <Menu
          trigger={
            <>
              <span className="account-avatar" aria-hidden="true">
                {accountInitial}
              </span>
              <span className="sr-only">{accountLabel}</span>
              <IconChevronDown />
            </>
          }
          items={accountItems}
        />
      </div>
    </header>
  );
}
