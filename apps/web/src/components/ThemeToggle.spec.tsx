import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { testI18n } from '../test/test-utils';
import { ThemeProvider } from '../context/ThemeContext';
import { ThemeToggle } from './ThemeToggle';

/**
 * KS-1693: ThemeToggle — icon swap + click toggles theme + aria-label.
 */

function renderToggle(initialTheme: 'light' | 'dark' = 'dark') {
  return render(
    <I18nextProvider i18n={testI18n}>
      <ThemeProvider initialTheme={initialTheme}>
        <ThemeToggle />
      </ThemeProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('renders with aria-label "Toggle theme"', () => {
    renderToggle('dark');
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
  });

  it('exposes current theme via data-theme-state', () => {
    renderToggle('light');
    expect(screen.getByTestId('theme-toggle').getAttribute('data-theme-state')).toBe('light');
  });

  it('click flips theme state attribute dark → light', () => {
    renderToggle('dark');
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('data-theme-state')).toBe('dark');
    act(() => btn.click());
    expect(btn.getAttribute('data-theme-state')).toBe('light');
  });

  it('click flips theme state attribute light → dark', () => {
    renderToggle('light');
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('data-theme-state')).toBe('light');
    act(() => btn.click());
    expect(btn.getAttribute('data-theme-state')).toBe('dark');
  });

  it('updates <html data-theme> on click', () => {
    renderToggle('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => screen.getByTestId('theme-toggle').click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists to localStorage on click', () => {
    renderToggle('dark');
    act(() => screen.getByTestId('theme-toggle').click());
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
