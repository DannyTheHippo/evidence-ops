import { useEffect, useState } from 'react';
import { IconMonitor, IconMoon, IconSun } from '../icons';
import Button from '../ui/Button';

export type ThemePreference = 'system' | 'light' | 'dark';

// index.html's inline boot script hardcodes this same string for flash-prevention, since it runs
// before any module (including this one) loads. The two must change together.
export const THEME_STORAGE_KEY = 'evidence-ops-theme';

// Ordered: each press advances to the next entry and wraps. `label` names the *current* state,
// which the button announces; the next state is named in the accessible label so a screen-reader
// user knows what pressing does, not just where they are.
const OPTIONS: { value: ThemePreference; label: string; Icon: typeof IconMonitor }[] = [
  { value: 'system', label: 'System', Icon: IconMonitor },
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
];

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

// Preference control: fails OPEN. Any storage error (disabled storage, quota, privacy mode)
// falls back to 'system' rather than blocking render — the page still has a working theme via
// the OS-level color-scheme media query.
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: the lazy useState initialiser and the colocated test both call this directly
export function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) {
      return stored;
    }
  } catch {
    // storage unavailable — fall through to the OS default
  }
  return 'system';
}

// Removing the attribute for 'system' hands control back to the `prefers-color-scheme` media
// query in tokens.css; setting it pins the palette regardless of the OS setting.
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: the mount effect and the colocated test both call this directly
export function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const currentIndex = OPTIONS.findIndex((option) => option.value === theme);
  const current = OPTIONS[currentIndex];
  const next = OPTIONS[(currentIndex + 1) % OPTIONS.length];
  const { Icon } = current;

  const handleCycle = () => {
    setTheme(next.value);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next.value);
    } catch {
      // storage unavailable — the selection still applies for this session, just not the next
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="theme-toggle"
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      title={`Theme: ${current.label}`}
      onClick={handleCycle}
    >
      <Icon />
      <span className="theme-toggle-label">{current.label}</span>
    </Button>
  );
}
