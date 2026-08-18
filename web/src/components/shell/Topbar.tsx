import { IconMenu } from '../icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import ConnectionStatus from './ConnectionStatus';
import { ThemeToggle } from './ThemeToggle';

interface TopbarProps {
  breadcrumbLabel: string;
  onOpenMenu: () => void;
  onLogout: () => void;
}

/** The chrome header above routed content: the drawer trigger (visible only below 768px, per
 * `.menu-toggle` in shell.css), the current page's breadcrumb, connection status, theme control,
 * and logout. */
export default function Topbar({ breadcrumbLabel, onOpenMenu, onLogout }: TopbarProps) {
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
      <span className="topbar-spacer" />
      <ConnectionStatus />
      <ThemeToggle />
      <Button variant="ghost" size="sm" onClick={onLogout}>
        Logout
      </Button>
    </header>
  );
}
