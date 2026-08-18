import { IconChevronDown, IconMenu } from '../icons';
import { useSession } from '../../lib/use-session';
import IconButton from '../ui/IconButton';
import Menu from '../ui/Menu';
import ConnectionStatus from './ConnectionStatus';
import { ThemeToggle } from './ThemeToggle';

interface TopbarProps {
  breadcrumbLabel: string;
  onOpenMenu: () => void;
  onLogout: () => void;
}

/** The chrome header above routed content: the drawer trigger (visible only below 768px, per
 * `.menu-toggle` in shell.css), the current page's breadcrumb, connection status, theme control,
 * and the account menu. Reads its own session via `useSession()` — `App.tsx` composes this
 * component without passing session data down, and the hook's cache means this costs no extra
 * probe beyond the one `App` already triggered. */
export default function Topbar({ breadcrumbLabel, onOpenMenu, onLogout }: TopbarProps) {
  const session = useSession();
  const me = session.status === 'authed' ? session.me : null;
  const accountLabel = me ? me.email : 'Account';
  const accountInitial = me ? me.email.charAt(0).toUpperCase() : '?';

  const accountItems = me
    ? [
        { label: me.email },
        { label: me.role === 'admin' ? 'Admin' : 'Member' },
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
      <span className="breadcrumb">{breadcrumbLabel}</span>
      <div className="topbar-end">
        <ConnectionStatus />
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
