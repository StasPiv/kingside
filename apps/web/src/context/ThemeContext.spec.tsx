import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from './ThemeContext';

/**
 * KS-1693: ThemeContext state + persistence + `<html data-theme>` + system
 * preference tracking.
 *
 * happy-dom doesn't implement `matchMedia`; several tests install a custom
 * stub via `vi.stubGlobal`.
 */

function installMatchMedia(prefersLight: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mq = {
    matches: prefersLight,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.push(cb);
    },
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    },
    dispatch: (matches: boolean) => {
      mq.matches = matches;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
  vi.stubGlobal('matchMedia', ((_q: string) => mq) as unknown as typeof window.matchMedia);
  return mq;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

function Harness() {
  const { theme, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={toggleTheme} data-testid="toggle">
        toggle
      </button>
      <button type="button" onClick={() => setTheme('light')} data-testid="set-light">
        set-light
      </button>
    </div>
  );
}

describe('ThemeContext initialization', () => {
  it('reads `data-theme` attribute set by the inline pre-boot script', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('falls back to localStorage when no attribute is present', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  // KS-4164: prefers-color-scheme игнорируется сознательно. Дефолт —
  // всегда 'dark', независимо от системных настроек.
  it('ignores matchMedia prefers-color-scheme: light when localStorage is empty', () => {
    installMatchMedia(true);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('defaults to dark when no signal is available', () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });
});

describe('ThemeContext toggle + persistence', () => {
  it('toggleTheme switches dark → light → dark', () => {
    render(
      <ThemeProvider initialTheme="dark">
        <Harness />
      </ThemeProvider>,
    );
    const toggle = screen.getByTestId('toggle');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    act(() => toggle.click());
    expect(screen.getByTestId('theme').textContent).toBe('light');
    act(() => toggle.click());
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('writes localStorage on every toggle', () => {
    render(
      <ThemeProvider initialTheme="dark">
        <Harness />
      </ThemeProvider>,
    );
    act(() => screen.getByTestId('toggle').click());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    act(() => screen.getByTestId('toggle').click());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('setTheme persists explicit value', () => {
    render(
      <ThemeProvider initialTheme="dark">
        <Harness />
      </ThemeProvider>,
    );
    act(() => screen.getByTestId('set-light').click());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('syncs <html data-theme> attribute', () => {
    render(
      <ThemeProvider initialTheme="dark">
        <Harness />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => screen.getByTestId('toggle').click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

// KS-4164: подписка на изменение OS-темы удалена — системные настройки
// больше не влияют. Тест переписан под новый контракт: вне зависимости
// от того, что говорит matchMedia, без явного выбора тема остаётся
// «dark».
describe('ThemeContext system preference tracking', () => {
  it('ignores OS change while the user has not chosen a theme', () => {
    const mq = installMatchMedia(false);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    act(() => mq.dispatch(true));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('stored explicit choice overrides any OS signal', () => {
    const mq = installMatchMedia(false);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    act(() => screen.getByTestId('toggle').click());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    act(() => mq.dispatch(false));
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });
});

describe('useTheme hook error surface', () => {
  it('throws a descriptive error when used outside ThemeProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrowError(
      /useTheme must be used within <ThemeProvider>/,
    );
    spy.mockRestore();
  });
});
