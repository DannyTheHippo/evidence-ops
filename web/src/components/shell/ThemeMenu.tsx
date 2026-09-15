import { useEffect, useState } from 'react';
import { IconCheck, IconMonitor, IconMoon, IconSun } from '../icons';
import Menu from '../ui/Menu';

export type ThemePreference = 'system' | 'light' | 'dark';

// index.html's inline boot script hardcodes this same string for flash-prevention, since it runs
// before any module (including this one) loads. The two must change together.
export const THEME_STORAGE_KEY = 'evidence-ops-theme';

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
function readStoredTheme(): ThemePreference {
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
function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export default function ThemeMenu() {
  const [theme, setTheme] = useState<ThemePreference>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const current = OPTIONS.find((option) => option.value === theme) ?? OPTIONS[0];
  const { Icon } = current;

  const select = (value: ThemePreference) => {
    setTheme(value);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // storage unavailable — the selection still applies for this session, just not the next
    }
  };

  return (
    <Menu
      trigger={
        <>
          <Icon />
          <span className="sr-only">Theme: {current.label}</span>
        </>
      }
      items={OPTIONS.map((option) => ({
        label:
          option.value === theme ? (
            <>
              {option.label}
              <IconCheck />
              <span className="sr-only">, current</span>
            </>
          ) : (
            option.label
          ),
        onSelect: () => select(option.value),
      }))}
      placement="bottom-end"
    />
  );
}
