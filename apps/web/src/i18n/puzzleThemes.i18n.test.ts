/**
 * KS-2500 (ADR-046 §4a). i18n-snapshot для `puzzleBrowser.themes.*`.
 *
 * Раньше тема `playVsEngine` приходила в `user_mistakes.themes` и в
 * UI отображалась латинским ключом «playVsEngine» среди русских
 * «Разгром/Связка». KS-2496 на клиенте отфильтровал её из дневника,
 * KS-2497 редиректит legacy-ссылки. Этот тикет добавляет переводы
 * на случай если тема прилетит в других местах (фильтры, recent
 * attempts из KS-2498, карточки puzzle-browser) — UI должен показать
 * «Play vs Engine» / «Против движка», не сырой ключ.
 *
 * Snapshot фиксирует обе локали: добавление новой темы валит тест,
 * удаление перевода — тоже. Так не уйдёт регрессия в виде потери
 * перевода или дрейфа between languages.
 */
import { describe, it, expect } from 'vitest';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

describe('puzzleBrowser.themes (KS-2500)', () => {
  it('en: тема playVsEngine переведена', () => {
    expect(en.puzzleBrowser.themes.playVsEngine).toBe('Play vs Engine');
  });

  it('ru: тема playVsEngine переведена', () => {
    expect(ru.puzzleBrowser.themes.playVsEngine).toBe('Против движка');
  });

  it('структура `themes` совпадает между en и ru (нет lost переводов)', () => {
    const enKeys = Object.keys(en.puzzleBrowser.themes).sort();
    const ruKeys = Object.keys(ru.puzzleBrowser.themes).sort();
    expect(enKeys).toEqual(ruKeys);
  });

  it('en snapshot полного списка тем', () => {
    expect(en.puzzleBrowser.themes).toMatchSnapshot();
  });

  it('ru snapshot полного списка тем', () => {
    expect(ru.puzzleBrowser.themes).toMatchSnapshot();
  });
});
