import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext';

/**
 * KS-3243 (ADR-076 §7 F1): mobile-only chips-bar для фильтров
 * /precision. Заменяет 4 строки desktop-фильтров (tabs «Все/Мои»,
 * segment «Тип», `Show solved`, ELO-slider) одной горизонтальной
 * лентой pill-чипов.
 *
 * Видимость управляется CSS — `.precision-filter-chips-bar` имеет
 * `display: none` на desktop и `display: flex` под
 * `@media (max-width: 767px)` (см. puzzle.css). DOM рендерится
 * всегда — это даёт корректную работу URL-state на любом viewport'е
 * без необходимости pивать дерево при resize.
 *
 * URL-state контракт остаётся прежним (см. PrecisionPage.tsx):
 *   - `mine=true` — только мои пазлы (только для авторизованных).
 *   - `objective=convertAdvantage|saveEquality` — фильтр по жанру.
 *   - `showSolved=true` — показать удержанные позиции.
 *   - `blundererEloMin/Max` — открывается через отдельный
 *     RatingSheet (см. `onOpenRatingSheet` ниже).
 *
 * test-id'ы prev-компонентов (precision-tab-all/mine,
 * precision-objective-{key}, precision-show-solved) переиспользуются
 * для chips — тесты не ломаются. Дополнительно вводим
 * `precision-chips-rating-open` и `precision-chips-reset`.
 */
export interface PrecisionFilterChipsBarProps {
  /**
   * Открыть PrecisionRatingSheet. PrecisionPage хранит флаг `open`
   * выше, чтобы reset мог его закрыть.
   */
  onOpenRatingSheet: () => void;
  /**
   * Текстовое значение фильтра рейтинга для бейджа над «+ Рейтинг»
   * pill'ом. Пусто, если фильтр не активен (slider на крайних позициях).
   * Передаётся из PrecisionPage, чтобы не дублировать парсинг.
   */
  ratingLabel: string | null;
}

const OBJECTIVES = ['all', 'convertAdvantage', 'saveEquality'] as const;
type Objective = (typeof OBJECTIVES)[number];

export function PrecisionFilterChipsBar({
  onOpenRatingSheet,
  ratingLabel,
}: PrecisionFilterChipsBarProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const mineParam = searchParams.get('mine') === 'true';
  const objectiveParam = searchParams.get('objective');
  const objective: Objective =
    objectiveParam === 'convertAdvantage' || objectiveParam === 'saveEquality'
      ? objectiveParam
      : 'all';
  const showSolved = searchParams.get('showSolved') === 'true';

  // Активный фильтр для бейджа `↺` (показываем кнопку «Сбросить»
  // только когда хоть что-то применено).
  const hasActiveFilters =
    mineParam ||
    objective !== 'all' ||
    showSolved ||
    ratingLabel !== null;

  const setMine = (next: boolean) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('mine', 'true');
    else sp.delete('mine');
    setSearchParams(sp, { replace: false });
  };
  const setObjective = (next: Objective) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('objective');
    else sp.set('objective', next);
    setSearchParams(sp, { replace: false });
  };
  const toggleShowSolved = () => {
    const sp = new URLSearchParams(searchParams);
    if (showSolved) sp.delete('showSolved');
    else sp.set('showSolved', 'true');
    setSearchParams(sp, { replace: false });
  };
  const resetAll = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('mine');
    sp.delete('objective');
    sp.delete('showSolved');
    sp.delete('blundererEloMin');
    sp.delete('blundererEloMax');
    setSearchParams(sp, { replace: false });
  };

  return (
    <div
      className="precision-filter-chips-bar"
      data-testid="precision-filter-chips-bar"
      role="toolbar"
      aria-label={t('precision.filterChips.label', 'Filters')}
    >
      {/* Authorship: видна только авторизованным (как и desktop-tabs). */}
      {user && (
        <>
          <button
            type="button"
            className={`precision-chip${!mineParam ? ' precision-chip--active' : ''}`}
            data-testid="precision-tab-all"
            aria-pressed={!mineParam}
            onClick={() => setMine(false)}
          >
            {t('precision.tabs.all', 'All')}
          </button>
          <button
            type="button"
            className={`precision-chip${mineParam ? ' precision-chip--active' : ''}`}
            data-testid="precision-tab-mine"
            aria-pressed={mineParam}
            onClick={() => setMine(true)}
          >
            {t('precision.tabs.mine', 'My puzzles')}
          </button>
          <span className="precision-chips__separator" aria-hidden="true" />
        </>
      )}

      {/* Objective: жанр (все/реализуй/ничью). */}
      {OBJECTIVES.map((key) => {
        const active = objective === key;
        const label =
          key === 'all'
            ? t('precision.objective.all', 'All')
            : key === 'convertAdvantage'
              ? t('puzzle.objective.convertAdvantage', 'Convert the advantage')
              : t('puzzle.objective.saveEquality', 'Save the draw');
        return (
          <button
            key={key}
            type="button"
            className={`precision-chip${active ? ' precision-chip--active' : ''}`}
            data-testid={`precision-objective-${key}`}
            aria-pressed={active}
            onClick={() => setObjective(key)}
          >
            {label}
          </button>
        );
      })}

      {/* Show-solved toggle pill (только для авторизованных — как и desktop-checkbox). */}
      {user && (
        <button
          type="button"
          className={`precision-chip${showSolved ? ' precision-chip--active' : ''}`}
          data-testid="precision-show-solved"
          aria-pressed={showSolved}
          onClick={toggleShowSolved}
        >
          {t('precision.showSolved', 'Show solved')}
        </button>
      )}

      {/* + Рейтинг pill → открыть bottom-sheet со слайдером. */}
      <button
        type="button"
        className={`precision-chip precision-chip--rating${ratingLabel ? ' precision-chip--active' : ''}`}
        data-testid="precision-chips-rating-open"
        onClick={onOpenRatingSheet}
      >
        {ratingLabel
          ? t('precision.filterChips.ratingActive', {
              defaultValue: 'Rating: {{range}}',
              range: ratingLabel,
            })
          : t('precision.filterChips.ratingOpen', '+ Rating')}
      </button>

      {/* Reset — только когда есть активные фильтры. */}
      {hasActiveFilters && (
        <button
          type="button"
          className="precision-chip precision-chip--reset"
          data-testid="precision-chips-reset"
          onClick={resetAll}
          aria-label={t('precision.filterChips.reset', 'Reset filters')}
          title={t('precision.filterChips.reset', 'Reset filters')}
        >
          ↺
        </button>
      )}
    </div>
  );
}
