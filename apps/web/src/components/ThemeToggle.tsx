import { useTranslation } from 'react-i18next';
import { FaMoon, FaSun } from 'react-icons/fa';
import { useTheme } from '../context/ThemeContext';

/**
 * KS-1693: Header theme-toggle button.
 *
 * Placed next to the language switcher (RU/EN) in the right section of the
 * MainLayout header. Single icon-button that toggles light ↔ dark on click.
 *
 * Icon semantics:
 *   - dark theme active → show sun (click to switch to light).
 *   - light theme active → show moon (click to switch to dark).
 *
 * The button reuses the existing `.lang-switcher` styling from the header
 * so the visual rhythm matches its neighbour. Styling of the light palette
 * itself is scoped to KS-1694 (layout).
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  const isDark = theme === 'dark';
  const nextThemeLabel = isDark
    ? t('theme.light', 'Light theme')
    : t('theme.dark', 'Dark theme');
  const ariaLabel = t('theme.toggle', 'Toggle theme');

  return (
    <button
      type="button"
      className="lang-switcher theme-toggle"
      onClick={toggleTheme}
      aria-label={ariaLabel}
      title={nextThemeLabel}
      data-testid="theme-toggle"
      data-theme-state={theme}
    >
      {isDark ? <FaSun size={14} aria-hidden="true" /> : <FaMoon size={14} aria-hidden="true" />}
    </button>
  );
}
