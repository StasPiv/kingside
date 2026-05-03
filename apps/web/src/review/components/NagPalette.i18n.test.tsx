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

// KS-2271: формулировки из design-doc §4.2 (chess-expert утвердил
// классическую терминологию Информатора, более короткую).
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
  18: 'White is winning',
  19: 'Black is winning',
};

const TOOLTIPS_RU: Record<number, string> = {
  1: 'Хороший ход',
  2: 'Ошибка',
  3: 'Блестящий ход',
  4: 'Зевок',
  5: 'Интересный ход',
  6: 'Сомнительный ход',
  10: 'Равная позиция',
  13: 'Неясная позиция',
  14: 'У белых чуть лучше',
  15: 'У чёрных чуть лучше',
  16: 'У белых перевес',
  17: 'У чёрных перевес',
  18: 'У белых выиграно',
  19: 'У чёрных выиграно',
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

/**
 * KS-2293 (ADR-038 §3.1, VC E3) — i18n-секция Variation color.
 * Ключи живут в `review.palette.variationColor.{title, green, blue,
 * yellow, red, clear}` (по решению координатора — `review.*`, не
 * `nag.*`, потому что variation-color — отдельная семантика).
 *
 * Тексты — семантические подписи цветов (Good line / Хорошая линия),
 * а не дословные цвета. Если design-doc §13.7 предписывает другую
 * формулировку — координатор пришлёт diff (как было в KS-2271).
 */
// KS-2293: формулировки приведены к design-doc §13.7
// (утверждено архитектором).
const VARIATION_COLOR_EN: Record<string, string> = {
  green: 'Good line',
  blue: 'Main alternative',
  yellow: 'Critical line',
  red: 'Bad line',
};

const VARIATION_COLOR_RU: Record<string, string> = {
  green: 'Хороший вариант',
  blue: 'Главная альтернатива',
  yellow: 'Критический вариант',
  red: 'Плохой вариант',
};

describe('<NagPalette> KS-2293 — i18n Variation color (review.palette.*)', () => {
  it('en: title + 4 swatch tooltip + clear из review.palette.variationColor.*', () => {
    const { getByTestId } = renderWithLocale(
      <NagPalette
        nags={[]}
        onChange={() => {}}
        isVariation
        onSetVariationColor={() => {}}
      />,
      'en',
    );
    const section = getByTestId('nag-palette-variation-color');
    expect(section.textContent).toContain('Variation color');
    for (const [color, expected] of Object.entries(VARIATION_COLOR_EN)) {
      const btn = getByTestId(`nag-palette-variation-color-${color}`);
      expect(btn.getAttribute('title')).toBe(expected);
      expect(btn.getAttribute('aria-label')).toBe(expected);
    }
    expect(
      getByTestId('nag-palette-variation-color-clear').textContent,
    ).toBe('Clear color');
  });

  it('ru: title + 4 swatch tooltip + clear из review.palette.variationColor.*', () => {
    const { getByTestId } = renderWithLocale(
      <NagPalette
        nags={[]}
        onChange={() => {}}
        isVariation
        onSetVariationColor={() => {}}
      />,
      'ru',
    );
    const section = getByTestId('nag-palette-variation-color');
    expect(section.textContent).toContain('Цвет варианта');
    for (const [color, expected] of Object.entries(VARIATION_COLOR_RU)) {
      const btn = getByTestId(`nag-palette-variation-color-${color}`);
      expect(btn.getAttribute('title')).toBe(expected);
      expect(btn.getAttribute('aria-label')).toBe(expected);
    }
    expect(
      getByTestId('nag-palette-variation-color-clear').textContent,
    ).toBe('Сбросить цвет');
  });

  it('snapshot en — секция Variation color в палитре', () => {
    const { container } = renderWithLocale(
      <NagPalette
        nags={[]}
        onChange={() => {}}
        isVariation
        currentVariationColor="green"
        onSetVariationColor={() => {}}
      />,
      'en',
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('snapshot ru — секция Variation color в палитре', () => {
    const { container } = renderWithLocale(
      <NagPalette
        nags={[]}
        onChange={() => {}}
        isVariation
        currentVariationColor="green"
        onSetVariationColor={() => {}}
      />,
      'ru',
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('JSON-проверка: все 6 ключей review.palette.variationColor.* в en и ru', () => {
    const expectedKeys = ['title', 'green', 'blue', 'yellow', 'red', 'clear'];
    const enVc = (en as {
      review: { palette: { variationColor: Record<string, string> } };
    }).review.palette.variationColor;
    const ruVc = (ru as {
      review: { palette: { variationColor: Record<string, string> } };
    }).review.palette.variationColor;
    for (const key of expectedKeys) {
      expect(enVc[key], `en missing ${key}`).toBeTruthy();
      expect(ruVc[key], `ru missing ${key}`).toBeTruthy();
    }
  });
});
