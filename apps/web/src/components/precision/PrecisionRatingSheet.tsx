import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

/**
 * KS-3243 (ADR-076 §7 F1): bottom-sheet с двухсторонним range-slider'ом
 * для фильтра «Рейтинг сыгравших игроков» (`blundererEloMin/Max`).
 *
 * Slider extract'ом из PrecisionPage (KS-2763 / KS-2767) — те же
 * `ELO_BOUNDS`, тот же debounce 300ms через `setSearchParams({ replace })`,
 * те же testid (`precision-elo-filter-{slider,min,max,value}`) —
 * существующие тесты PrecisionRoute / PrecisionPage не ломаются.
 *
 * Visibility:
 *   - На mobile chips-bar показывает «+ Рейтинг» pill, который
 *     меняет проп `open` снаружи.
 *   - На desktop sheet НЕ рендерится (PrecisionPage не пробрасывает
 *     `open=true` на desktop) — фильтр там остаётся inline в header'е.
 *   - Закрытие: tap по backdrop, кнопка «Готово», или клавиша Esc.
 */
const ELO_BOUNDS = { min: 800, max: 3000, step: 50 } as const;

export interface PrecisionRatingSheetProps {
  open: boolean;
  onClose: () => void;
}

export function PrecisionRatingSheet({
  open,
  onClose,
}: PrecisionRatingSheetProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const blundererEloMinRaw = searchParams.get('blundererEloMin');
  const blundererEloMaxRaw = searchParams.get('blundererEloMax');
  const eloMinValue =
    blundererEloMinRaw && /^\d+$/.test(blundererEloMinRaw)
      ? Number(blundererEloMinRaw)
      : ELO_BOUNDS.min;
  const eloMaxValue =
    blundererEloMaxRaw && /^\d+$/.test(blundererEloMaxRaw)
      ? Number(blundererEloMaxRaw)
      : ELO_BOUNDS.max;

  const sliderTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (sliderTimerRef.current) window.clearTimeout(sliderTimerRef.current);
    },
    [],
  );
  // Debounce 300ms — тот же контракт, что в PrecisionPage до этой задачи.
  const debouncedSync = (newMin: number, newMax: number) => {
    if (sliderTimerRef.current) window.clearTimeout(sliderTimerRef.current);
    sliderTimerRef.current = window.setTimeout(() => {
      const sp = new URLSearchParams(searchParams);
      if (newMin <= ELO_BOUNDS.min) sp.delete('blundererEloMin');
      else sp.set('blundererEloMin', String(newMin));
      if (newMax >= ELO_BOUNDS.max) sp.delete('blundererEloMax');
      else sp.set('blundererEloMax', String(newMax));
      if (sp.toString() !== searchParams.toString()) {
        setSearchParams(sp, { replace: true });
      }
    }, 300);
  };

  // Esc → закрыть. Стандартный паттерн bottom-sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="precision-rating-sheet"
      data-testid="precision-rating-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('precision.eloFilter.label', 'Rating')}
    >
      <button
        type="button"
        className="precision-rating-sheet__backdrop"
        data-testid="precision-rating-sheet-backdrop"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
      />
      <div className="precision-rating-sheet__panel">
        <header className="precision-rating-sheet__header">
          <h2 className="precision-rating-sheet__title">
            {t('precision.eloFilter.label', 'Rating')}
          </h2>
          <button
            type="button"
            className="precision-rating-sheet__close"
            data-testid="precision-rating-sheet-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </header>
        <div
          className="precision-elo-filter"
          data-testid="precision-elo-filter"
        >
          <span
            className="precision-elo-filter__value"
            data-testid="precision-elo-filter-value"
          >
            {eloMinValue} — {eloMaxValue}
          </span>
          <div
            className="precision-elo-filter__slider"
            data-testid="precision-elo-filter-slider"
            style={
              {
                '--p-min': String(
                  (eloMinValue - ELO_BOUNDS.min) /
                    (ELO_BOUNDS.max - ELO_BOUNDS.min),
                ),
                '--p-max': String(
                  (eloMaxValue - ELO_BOUNDS.min) /
                    (ELO_BOUNDS.max - ELO_BOUNDS.min),
                ),
              } as React.CSSProperties
            }
          >
            <input
              type="range"
              min={ELO_BOUNDS.min}
              max={ELO_BOUNDS.max}
              step={ELO_BOUNDS.step}
              value={eloMinValue}
              aria-label={t('precision.eloFilter.minAria', 'Minimum rating')}
              data-testid="precision-elo-filter-min"
              className="precision-elo-filter__range precision-elo-filter__range--min"
              onChange={(e) => {
                const v = Math.min(
                  Number(e.target.value),
                  eloMaxValue - ELO_BOUNDS.step,
                );
                debouncedSync(v, eloMaxValue);
              }}
            />
            <input
              type="range"
              min={ELO_BOUNDS.min}
              max={ELO_BOUNDS.max}
              step={ELO_BOUNDS.step}
              value={eloMaxValue}
              aria-label={t('precision.eloFilter.maxAria', 'Maximum rating')}
              data-testid="precision-elo-filter-max"
              className="precision-elo-filter__range precision-elo-filter__range--max"
              onChange={(e) => {
                const v = Math.max(
                  Number(e.target.value),
                  eloMinValue + ELO_BOUNDS.step,
                );
                debouncedSync(eloMinValue, v);
              }}
            />
          </div>
        </div>
        <footer className="precision-rating-sheet__footer">
          <button
            type="button"
            className="precision-rating-sheet__done"
            data-testid="precision-rating-sheet-done"
            onClick={onClose}
          >
            {t('common.done', 'Done')}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * KS-3243: helper для chips-bar — формирует текстовый лейбл фильтра
 * рейтинга, если фильтр активен. На крайних значениях ('800 — 3000')
 * возвращает null, чтобы chips-bar показал «+ Рейтинг» вместо
 * «Rating: 800 — 3000» (полный диапазон = фильтра нет).
 */
export function ratingLabelFromUrl(
  searchParams: URLSearchParams,
): string | null {
  const minRaw = searchParams.get('blundererEloMin');
  const maxRaw = searchParams.get('blundererEloMax');
  if (!minRaw && !maxRaw) return null;
  const min =
    minRaw && /^\d+$/.test(minRaw) ? Number(minRaw) : ELO_BOUNDS.min;
  const max =
    maxRaw && /^\d+$/.test(maxRaw) ? Number(maxRaw) : ELO_BOUNDS.max;
  if (min <= ELO_BOUNDS.min && max >= ELO_BOUNDS.max) return null;
  return `${min}–${max}`;
}
