import { Link } from 'react-router-dom';
import { IconChevronDown, IconMenu } from '../icons';
import type { BreadcrumbItem } from '../../lib/breadcrumbs';
import { useBreadcrumbTrail } from '../../lib/breadcrumbs';
import { useSession } from '../../lib/use-session';
import Badge from '../ui/Badge';
import IconButton from '../ui/IconButton';
import Menu from '../ui/Menu';
import ConnectionStatus from './ConnectionStatus';
import ThemeMenu from './ThemeMenu';

interface TopbarProps {
  breadcrumbFallback: string;
  onOpenMenu: () => void;
  onLogout: () => void;
}

/** Renders `trail` as an ordered breadcrumb list, three levels at most (Section › Page ›
 * Record). Any crumb but the last renders as a `<Link>` when it carries a `to`, including the
 * first — a Section crumb with nowhere of its own to go simply omits `to` and stays plain text.
 * The last crumb is always the current page: plain text carrying `aria-current="page"` and the
 * `breadcrumb-current` class (its truncation styling target in shell.css), never a link either.
 * Separators are explicit `<span aria-hidden="true">` elements rather than CSS generated content,
 * so a screen reader that voices `::before` content never reads the slash aloud. At ≤560px every
 * crumb but the last two collapses into a single non-interactive "…" (`.breadcrumb-collapse`,
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
          const isLinkable = Boolean(item.to) && !isLast;

          return (
            <li
              key={`${item.label}-${index}`}
              className={index < collapsedCount ? 'breadcrumb-collapse' : undefined}
            >
              {!isFirst && (
                <span className="breadcrumb-sep" aria-hidden="true">
                  /
                </span>
              )}
              {isLast ? (
                <span aria-current="page" className="breadcrumb-current">
                  {item.label}
                </span>
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
 * signed-in identity, theme control, and the account menu (Logout only — the trigger's own
 * sr-only name carries email and role instead, since `.topbar-identity` hides them below 768px).
 * Reads its own session via `useSession()` — `App.tsx` composes this component without passing
 * session data down, and the hook's cache means this costs no extra probe beyond the one `App`
 * already triggered.
 *
 * `breadcrumbFallback` is the single Page-level crumb `App.tsx` derives from the route; it is
 * what `useBreadcrumbTrail` returns while no page has published a trail of its own via
 * `useBreadcrumbs`. */
export default function Topbar({ breadcrumbFallback, onOpenMenu, onLogout }: TopbarProps) {
  const session = useSession();
  const me = session.status === 'authed' ? session.me : null;
  const roleLabel = me ? (me.role === 'admin' ? 'Admin' : 'Member') : null;
  const accountLabel = me ? `${me.email}, ${roleLabel}` : 'Account';
  const accountInitial = me ? me.email.charAt(0).toUpperCase() : '?';
  const trail = useBreadcrumbTrail([{ label: breadcrumbFallback }]);

  const accountItems = [{ label: 'Logout', onSelect: onLogout, tone: 'danger' as const }];

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
        <ThemeMenu />
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
          placement="bottom-end"
        />
      </div>
    </header>
  );
}
