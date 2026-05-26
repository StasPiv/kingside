/**
 * KS-3361 (ADR-080 §7 F1). Bottom-sheet выбора precision-тем для
 * фильтрации `/precision`. 6 секций (`PRECISION_THEME_GROUPS`) с
 * multi-select checkboxes. Каждая тема со счётчиком из `GET
 * /precision/theme-counts` — темы с `count===0` рендерятся, но
 * disabled (бэкенд не вернёт их в `/precision/next`).
 *
 * URL contract (KS-3362): `?themes=pin,fork,sacrifice` (CSV). Этот
 * компонент работает с локальным черновиком выбора и применяет его
 * наружу через `onApply(selectedThemes[])`. Caller отвечает за запись
 * в URL.
 *
 * Visibility:
 *  - Mobile: chips-bar pill `[+ Темы]` / `[Темы: N ✕]` (KS-3361
 *    addition в `PrecisionFilterChipsBar`) меняет проп `open`.
 *  - Desktop: тоже доступно через тот же chips-bar (chips-bar теперь
 *    видим на обоих viewport'ах по ADR-076 — см. KS-3347).
 *  - Закрытие: tap backdrop, кнопка ×, кнопка «Применить»/«Сбросить»,
 *    Esc.
 *
 * Localization (KS-3360):
 *  - Названия тем: `precision.themes.<themeKey>` (изолированный
 *    namespace; RU от chess-expert, EN мы; не пересекается с старым
 *    `themes.*` где есть playVsEngine/master/long вне whitelist'а).
 *  - Названия групп: `precision.themeGroups.<key>`.
 *  - Лейблы UI: `precision.themes.{title,apply,reset,chipOpen,chipActive}`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PRECISION_THEME_GROUPS,
  type PrecisionThemeGroupKey,
} from '@kingside/shared';

const GROUP_KEYS: ReadonlyArray<PrecisionThemeGroupKey> = [
  'tactics',
  'mates',
  'endgame',
  'phase',
  'advantage',
  'misc',
];

export interface PrecisionThemesSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Текущий выбор тем (CSV-разобран caller'ом). Bottom-sheet хранит
   * собственный черновик и применяет его через `onApply`.
   */
  selectedThemes: ReadonlyArray<string>;
  /**
   * Применить выбор. Caller записывает в URL `?themes=…`. После
   * вызова sheet НЕ закрывается автоматически — caller сам решает
   * (мы закрываем тут же для UX-консистентности).
   */
  onApply: (themes: string[]) => void;
  /**
   * Счётчики из `precisionApi.getThemeCounts`. Темы, отсутствующие в
   * map, считаем `count = 0` (бэкенд может опускать нули — см.
   * `PrecisionThemeCountsResponse`).
   */
  themeCounts: Record<string, number> | null;
}

export function PrecisionThemesSheet({
  open,
  onClose,
  selectedThemes,
  onApply,
  themeCounts,
}: PrecisionThemesSheetProps) {
  const { t } = useTranslation();

  // Локальный черновик. При открытии sheet'а синхронизируем с
  // selectedThemes из props (URL → черновик); внутри юзер тыкает
  // checkbox'ы — только тут, в URL пишем по «Применить».
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(selectedThemes),
  );
  useEffect(() => {
    if (open) setDraft(new Set(selectedThemes));
  }, [open, selectedThemes]);

  // Collapsible-секции: по умолчанию все свернуты, кроме первой
  // (tactics) — самая частая. State хранится локально, не в URL.
  const [collapsed, setCollapsed] = useState<Set<PrecisionThemeGroupKey>>(
    () => new Set<PrecisionThemeGroupKey>(['mates', 'endgame', 'phase', 'advantage', 'misc']),
  );
  const toggleCollapsed = useCallback((key: PrecisionThemeGroupKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleTheme = useCallback((theme: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(theme)) next.delete(theme);
      else next.add(theme);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    onApply(Array.from(draft));
    onClose();
  }, [draft, onApply, onClose]);

  const handleReset = useCallback(() => {
    setDraft(new Set());
    onApply([]);
    onClose();
  }, [onApply, onClose]);

  // Esc → закрытие. Стандарт.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Кол-во выбранных в черновике — для заголовка «Темы (3)».
  const draftCount = draft.size;

  // Считалка с дефолтом 0.
  const getCount = useCallback(
    (theme: string): number => themeCounts?.[theme] ?? 0,
    [themeCounts],
  );

  // Сумма по группе — для подписи у заголовка секции.
  const groupTotals = useMemo(() => {
    const totals: Record<PrecisionThemeGroupKey, number> = {
      tactics: 0,
      mates: 0,
      endgame: 0,
      phase: 0,
      advantage: 0,
      misc: 0,
    };
    for (const key of GROUP_KEYS) {
      for (const theme of PRECISION_THEME_GROUPS[key]) {
        totals[key] += getCount(theme);
      }
    }
    return totals;
  }, [getCount]);

  if (!open) return null;

  return (
    <div
      className="precision-themes-sheet"
      data-testid="precision-themes-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('precision.themes.title', 'Themes')}
    >
      <button
        type="button"
        className="precision-themes-sheet__backdrop"
        data-testid="precision-themes-sheet-backdrop"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
      />
      <div className="precision-themes-sheet__panel">
        <header className="precision-themes-sheet__header">
          <h2 className="precision-themes-sheet__title">
            {t('precision.themes.title', 'Themes')}
            {draftCount > 0 && (
              <span
                className="precision-themes-sheet__count"
                data-testid="precision-themes-sheet-count"
              >
                {' '}
                ({draftCount})
              </span>
            )}
          </h2>
          <button
            type="button"
            className="precision-themes-sheet__close"
            data-testid="precision-themes-sheet-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </header>
        <div
          className="precision-themes-sheet__body"
          data-testid="precision-themes-sheet-body"
        >
          {GROUP_KEYS.map((groupKey) => {
            const isCollapsed = collapsed.has(groupKey);
            const themes = PRECISION_THEME_GROUPS[groupKey];
            const groupTotal = groupTotals[groupKey];
            return (
              <section
                key={groupKey}
                className={`precision-themes-sheet__group${
                  isCollapsed ? ' precision-themes-sheet__group--collapsed' : ''
                }`}
                data-testid={`precision-themes-sheet-group-${groupKey}`}
                data-collapsed={isCollapsed ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="precision-themes-sheet__group-toggle"
                  data-testid={`precision-themes-sheet-group-toggle-${groupKey}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapsed(groupKey)}
                >
                  <span className="precision-themes-sheet__group-name">
                    {t(`precision.themeGroups.${groupKey}`, groupKey)}
                  </span>
                  <span
                    className="precision-themes-sheet__group-total"
                    data-testid={`precision-themes-sheet-group-total-${groupKey}`}
                  >
                    ({groupTotal})
                  </span>
                  <span
                    className="precision-themes-sheet__group-caret"
                    aria-hidden="true"
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="precision-themes-sheet__list">
                    {themes.map((theme) => {
                      const count = getCount(theme);
                      const disabled = count === 0;
                      const checked = draft.has(theme);
                      return (
                        <li
                          key={theme}
                          className={`precision-themes-sheet__item${
                            disabled
                              ? ' precision-themes-sheet__item--disabled'
                              : ''
                          }`}
                          data-testid={`precision-themes-sheet-item-${theme}`}
                          data-count={String(count)}
                          data-disabled={disabled ? 'true' : 'false'}
                          data-checked={checked ? 'true' : 'false'}
                        >
                          <label className="precision-themes-sheet__label">
                            <input
                              type="checkbox"
                              className="precision-themes-sheet__checkbox"
                              data-testid={`precision-themes-sheet-checkbox-${theme}`}
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleTheme(theme)}
                            />
                            <span className="precision-themes-sheet__theme-name">
                              {t(`precision.themes.${theme}`, theme)}
                            </span>
                            <span className="precision-themes-sheet__theme-count">
                              ({count})
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <footer className="precision-themes-sheet__footer">
          <button
            type="button"
            className="precision-themes-sheet__reset"
            data-testid="precision-themes-sheet-reset"
            onClick={handleReset}
            disabled={draftCount === 0 && selectedThemes.length === 0}
          >
            {t('precision.themes.reset', 'Reset')}
          </button>
          <button
            type="button"
            className="precision-themes-sheet__apply"
            data-testid="precision-themes-sheet-apply"
            onClick={handleApply}
          >
            {t('precision.themes.apply', 'Apply')}
          </button>
        </footer>
      </div>
    </div>
  );
}
