import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext';
import { readPrecisionScope } from '../../utils/precisionUrlMigrate';
import type { PrecisionScope, PrecisionScopeCountsResponse } from '@kingside/shared';

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
  /**
   * KS-3347 (ADR-079). Счётчики на 3 scope-pill'ах из
   * `GET /precision/scope-counts`. `null` пока загружается / для гостя.
   */
  scopeCounts?: PrecisionScopeCountsResponse | null;
  /**
   * KS-3361 (ADR-080 §7 F1). Открыть `PrecisionThemesSheet`. State
   * `open` хранится в PrecisionPage (выше), чтобы reset мог его
   * закрыть. Если не передан — chip скрыт (defensive).
   */
  onOpenThemesSheet?: () => void;
  /**
   * KS-3361. Список выбранных тем (parsed из `?themes=…` caller'ом).
   * Используется для chip-label («+ Темы» / «Темы: 3»).
   */
  selectedThemes?: ReadonlyArray<string>;
}

const OBJECTIVES = ['all', 'convertAdvantage', 'saveEquality'] as const;
type Objective = (typeof OBJECTIVES)[number];

export function PrecisionFilterChipsBar({
  onOpenRatingSheet,
  ratingLabel,
  scopeCounts,
  onOpenThemesSheet,
  selectedThemes,
}: PrecisionFilterChipsBarProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // KS-3347 (ADR-079 §2.6). 3 scope-pill'а вместо старых 2-pill «Все/Мои».
  const scope = readPrecisionScope(searchParams, Boolean(user));
  const objectiveParam = searchParams.get('objective');
  const objective: Objective =
    objectiveParam === 'convertAdvantage' || objectiveParam === 'saveEquality'
      ? objectiveParam
      : 'all';
  const showSolved = searchParams.get('showSolved') === 'true';

  // KS-3361: учитываем выбранные темы в активных фильтрах.
  const selectedThemesCount = selectedThemes ? selectedThemes.length : 0;
  // Активный фильтр для бейджа `↺` (показываем кнопку «Сбросить»
  // только когда хоть что-то применено).
  const hasActiveFilters =
    scope !== 'server' ||
    objective !== 'all' ||
    showSolved ||
    ratingLabel !== null ||
    selectedThemesCount > 0;

  const setScope = (next: PrecisionScope) => {
    const sp = new URLSearchParams(searchParams);
    // KS-3347: миграционные параметры легаси удаляем при первом
    // взаимодействии — синхронизируем с новой схемой.
    sp.delete('mine');
    sp.delete('visibility');
    if (next === 'server') sp.delete('scope');
    else sp.set('scope', next);
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
    sp.delete('scope');
    sp.delete('mine');
    sp.delete('visibility');
    sp.delete('objective');
    sp.delete('showSolved');
    sp.delete('blundererEloMin');
    sp.delete('blundererEloMax');
    // KS-3361: тоже сбрасываем выбранные темы.
    sp.delete('themes');
    setSearchParams(sp, { replace: false });
  };

  const fmtCount = (n: number | undefined) =>
    n != null ? ` (${n})` : '';

  return (
    <div
      className="precision-filter-chips-bar"
      data-testid="precision-filter-chips-bar"
      role="toolbar"
      aria-label={t('precision.filterChips.label', 'Filters')}
    >
      {/* KS-3347 (ADR-079 §2.6). 3 scope-pill'а вместо «Все/Мои».
          Гостям виден только «Серверные» (drafts/published скрыты —
          бэк всё равно 401-ит запросы с mine=true). data-testid
          сохранён для precision-tab-all (~scope=server) для обратной
          совместимости старых интеграционных тестов; добавлены явные
          `precision-scope-{server,drafts,published}`. */}
      <button
        type="button"
        className={`precision-chip${scope === 'server' ? ' precision-chip--active' : ''}`}
        data-testid="precision-scope-server"
        aria-pressed={scope === 'server'}
        onClick={() => setScope('server')}
      >
        {t('precision.scope.server', 'Server')}
        {fmtCount(scopeCounts?.server)}
      </button>
      {user && (
        <>
          <button
            type="button"
            className={`precision-chip${scope === 'drafts' ? ' precision-chip--active' : ''}`}
            data-testid="precision-scope-drafts"
            aria-pressed={scope === 'drafts'}
            onClick={() => setScope('drafts')}
          >
            {t('precision.scope.drafts', 'My drafts')}
            {fmtCount(scopeCounts?.drafts)}
          </button>
          <button
            type="button"
            className={`precision-chip${scope === 'published' ? ' precision-chip--active' : ''}`}
            data-testid="precision-scope-published"
            aria-pressed={scope === 'published'}
            onClick={() => setScope('published')}
          >
            {t('precision.scope.published', 'My published')}
            {fmtCount(scopeCounts?.published)}
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

      {/* KS-3361 (ADR-080 §7 F1). «+ Темы» pill открывает bottom-sheet
          `PrecisionThemesSheet`. Active-state — когда выбран хотя бы
          одна тема (число в подписи). Защитно скрываем chip, если
          caller не передал `onOpenThemesSheet`. */}
      {onOpenThemesSheet && (
        <button
          type="button"
          className={`precision-chip precision-chip--themes${selectedThemesCount > 0 ? ' precision-chip--active' : ''}`}
          data-testid="precision-chips-themes-open"
          aria-pressed={selectedThemesCount > 0}
          onClick={onOpenThemesSheet}
        >
          {selectedThemesCount > 0
            ? t('precision.themes.chipActive', {
                defaultValue: 'Themes: {{count}}',
                count: selectedThemesCount,
              })
            : t('precision.themes.chipOpen', '+ Themes')}
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
