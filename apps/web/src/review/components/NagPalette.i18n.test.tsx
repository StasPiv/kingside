import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ReactElement } from 'react';

import en from '../../i18n/locales/en/translation.json';
import ru from '../../i18n/locales/ru/translation.json';
import { ThemeProvider } from '../../context/ThemeContext';
import { BoardSettingsProvider } from '../../context/BoardSettingsContext';
import { NagPalette } from './NagPalette';

/**
 * KS-2271 — snapshot-тесты NagPalette на двух locale (en/ru).
 *
 * Зачем отдельный test-файл вместо общего test-utils: общий
 * `renderWithProviders` всегда мокает `i18n` через `en`. Здесь нужно
 * рендерить с реальными ru-переводами, чтобы проверить что ключи
 * `nag.tooltip.<symbol>` и `nag.group.{quality,evaluation}` подхвачены
 * в ru/translation.json и не fall back'ают на defaultValue.
 */

function makeI18n(lng: 'en' | 'ru'): I18nInstance {
  const inst = i18n.createInstance();
  inst.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return inst;
}

function renderWithLocale(ui: ReactElement, lng: 'en' | 'ru') {
  const inst = makeI18n(lng);
  return render(
    <I18nextProvider i18n={inst}>
      <ThemeProvider initialTheme="dark">
        <BoardSettingsProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </BoardSettingsProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

const TOOLTIPS_EN: Record<number, string> = {
  1: 'Good move',
  2: 'Mistake',
  3: 'Brilliant move',
  4: 'Blunder',
  5: 'Interesting move',
  6: 'Dubious move',
  10: 'Equal position',
  13: 'Unclear position',
  14: 'White is slightly better',
  15: 'Black is slightly better',
  16: 'White is clearly better',
  17: 'Black is clearly better',
  18: 'White has a winning advantage',
  19: 'Black has a winning advantage',
};

const TOOLTIPS_RU: Record<number, string> = {
  1: 'Хороший ход',
  2: 'Ошибка',
  3: 'Блестящий ход',
  4: 'Грубая ошибка',
  5: 'Интересный ход',
  6: 'Сомнительный ход',
  10: 'Равная позиция',
  13: 'Неясная позиция',
  14: 'У белых небольшое преимущество',
  15: 'У чёрных небольшое преимущество',
  16: 'У белых явное преимущество',
  17: 'У чёрных явное преимущество',
  18: 'У белых решающее преимущество',
  19: 'У чёрных решающее преимущество',
};

describe('<NagPalette> KS-2271 — i18n tooltips и group-labels', () => {
  it('en: 14 tooltip + group labels из nag.* (translation.json), не fallback на defaultValue', () => {
    const { getByTestId } = renderWithLocale(
      <NagPalette nags={[]} onChange={() => {}} />,
      'en',
    );
    for (const [nag, expected] of Object.entries(TOOLTIPS_EN)) {
      const btn = getByTestId(`nag-palette-btn-${nag}`);
      expect(btn.getAttribute('title')).toBe(expected);
      expect(btn.getAttribute('aria-label')).toBe(expected);
    }
    // Группы.
    const palette = getByTestId('nag-palette');
    expect(palette.textContent).toContain('Move quality');
    expect(palette.textContent).toContain('Position evaluation');
    expect(palette.textContent).toContain('Clear annotations');
  });

  it('ru: 14 tooltip + group labels из nag.* (translation.json)', () => {
    const { getByTestId } = renderWithLocale(
      <NagPalette nags={[]} onChange={() => {}} />,
      'ru',
    );
    for (const [nag, expected] of Object.entries(TOOLTIPS_RU)) {
      const btn = getByTestId(`nag-palette-btn-${nag}`);
      expect(btn.getAttribute('title')).toBe(expected);
      expect(btn.getAttribute('aria-label')).toBe(expected);
    }
    const palette = getByTestId('nag-palette');
    expect(palette.textContent).toContain('Качество хода');
    expect(palette.textContent).toContain('Оценка позиции');
    expect(palette.textContent).toContain('Снять аннотации');
  });

  it('snapshot en — фиксирует структуру и переводы', () => {
    const { container } = renderWithLocale(
      <NagPalette nags={[3, 14]} onChange={() => {}} />,
      'en',
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('snapshot ru — фиксирует структуру и переводы', () => {
    const { container } = renderWithLocale(
      <NagPalette nags={[3, 14]} onChange={() => {}} />,
      'ru',
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('JSON-проверка: все 14 ключей nag.tooltip.<symbol> присутствуют в en и ru', () => {
    const expectedSymbols = [
      '!', '?', '!!', '??', '!?', '?!',
      '=', '∞', '⩲', '⩱', '±', '∓', '+−', '−+',
    ];
    const enTooltips = (en as { nag: { tooltip: Record<string, string> } }).nag.tooltip;
    const ruTooltips = (ru as { nag: { tooltip: Record<string, string> } }).nag.tooltip;
    for (const sym of expectedSymbols) {
      expect(enTooltips[sym], `en missing ${sym}`).toBeTruthy();
      expect(ruTooltips[sym], `ru missing ${sym}`).toBeTruthy();
    }
    // Группы.
    const enGroup = (en as { nag: { group: Record<string, string> } }).nag.group;
    const ruGroup = (ru as { nag: { group: Record<string, string> } }).nag.group;
    expect(enGroup.quality).toBeTruthy();
    expect(enGroup.evaluation).toBeTruthy();
    expect(ruGroup.quality).toBeTruthy();
    expect(ruGroup.evaluation).toBeTruthy();
  });
});
