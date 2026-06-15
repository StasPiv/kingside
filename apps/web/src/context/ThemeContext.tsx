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
 * KS-4164: дефолт — `dark`. Системные настройки `prefers-color-scheme` НЕ
 * учитываются ни на пре-бутстрапе (`index.html` inline-скрипт), ни в
 * `resolveInitialTheme`, ни в live-listener'е. Пользователь жаловался, что
 * при first-load тема тёмная, а после reload становилась светлой — это
 * происходило, когда ОС была в light-режиме и pre-boot скрипт читал
 * `prefers-color-scheme` раньше, чем сработать успевал inline-скрипт у
 * других вкладок. Теперь дефолт фиксирован `dark`, явный выбор юзера
 * (`localStorage.theme`) уважается как раньше.
 *
 * Initialization order:
 *   1. Inline `<script>` в `index.html` читает `localStorage.theme`, ставит
 *      `<html data-theme="dark|light">` ДО первого рендера. Если ключа нет
 *      — fallback `dark`.
 *   2. `ThemeProvider` читает атрибут с `<html>` как начальное состояние —
 *      React-дерево согласовано с pre-bootstrap значением, FOUC нет.
 *   3. Клик по переключателю → state обновляется → эффект пишет
 *      атрибут на `<html>` и `localStorage.theme`.
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
 *   3. `'dark'` — default (KS-4164: prefers-color-scheme игнорируется).
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

  // KS-4164: подписка на изменение OS-темы удалена. Системные настройки
  // больше не влияют на наш дефолт — пользователь сам переключает через
  // ThemeToggle, если хочет светлую.

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
