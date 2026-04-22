import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * KS-1693: UI theme state management.
 *
 * Scope (frontend): scaffold — state, persistence, `data-theme` attribute on
 * `<html>`. CSS variables / light palette are owned by `layout` (KS-1694,
 * parallel). This context intentionally does NOT touch any styles.
 *
 * Chess-board colors are **not** part of this context — they are configured
 * via `BoardSettingsContext` (`BOARD_THEMES`) and are independent of UI theme.
 *
 * Initialization order:
 *   1. Inline `<script>` in `index.html` reads `localStorage.theme` (fallback
 *      to `prefers-color-scheme`) and sets `<html data-theme="...">` BEFORE
 *      React boots. This prevents FOUC (flash of wrong theme) на первом кадре.
 *   2. `ThemeProvider` reads the attribute back from `<html>` as the initial
 *      state, so React tree is consistent with the pre-bootstrap value.
 *   3. User clicks toggle → state updates → effect writes both the attribute
 *      and `localStorage.theme`.
 *
 * When the user has NOT chosen a theme yet (`localStorage.theme` unset) and
 * the OS-level preference changes, we mirror it live via the `matchMedia`
 * listener. Once the user clicks the toggle, `localStorage.theme` is set and
 * the listener no longer overrides the explicit choice.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark';
}

/**
 * Resolve the initial theme. Prefers:
 *   1. Attribute already set on `<html>` by the inline pre-boot script.
 *   2. Explicit `localStorage.theme` value.
 *   3. `prefers-color-scheme: light` media query.
 *   4. `'dark'` as the historical default.
 */
export function resolveInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (isTheme(attr)) return attr;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (isTheme(stored)) return stored;
    } catch {
      /* noop — storage unavailable (private mode, SSR, etc.) */
    }
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'dark';
}

interface ThemeProviderProps {
  children: ReactNode;
  /**
   * Optional override — used by tests to bypass `localStorage`/`matchMedia`
   * probing. Production code should omit this.
   */
  initialTheme?: Theme;
}

export function ThemeProvider({ children, initialTheme }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(
    () => initialTheme ?? resolveInitialTheme(),
  );

  // Apply to <html data-theme="..."> on every change. Kept explicit (both
  // values written) — the layout team's CSS uses both `:root[data-theme="dark"]`
  // and `:root[data-theme="light"]` selectors for readability.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* noop — storage unavailable */
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  // Follow OS-level preference while the user has NOT made an explicit choice.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        /* noop */
      }
      if (isTheme(stored)) return; // user chose — don't override
      setThemeState(e.matches ? 'light' : 'dark');
    };
    // Safari <14 doesn't support addEventListener on MediaQueryList.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within <ThemeProvider>');
  }
  return ctx;
}
