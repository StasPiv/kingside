import { useTranslation } from 'react-i18next';
import type { ArchiveTimeControlCategory } from '@kingside/shared';

/**
 * KS-2115/KS-2122: общий чип-селектор «Контроль времени» для форм
 * архива партий. Множественный выбор: клик переключает категорию.
 * «Любой» = пустой массив (фильтр не применяется).
 *
 * Используется в:
 *   - `ArchiveMetadataFilters` (списки `/archive/games`,
 *     `/archive/players/:slug`);
 *   - `ArchiveSearchForm` (форма поиска на лобби `/archive`).
 *
 * `unknown` исключён из UI: в проде партий с этой категорией нет
 * (KS-2118 завершил backfill 323К/323К), а пользователю термин
 * «Неизвестный контроль» в форме фильтра не нужен.
 */

export const TIME_CONTROL_PRESETS: readonly ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
];

export interface ArchiveTimeControlChipsProps {
  values: ArchiveTimeControlCategory[];
  onChange: (next: ArchiveTimeControlCategory[]) => void;
  /**
   * Префикс для `data-testid`. Уникальный на странице — чтобы тесты
   * не упали на дубли при двух экземплярах в одном DOM (на лендинге
   * и в metadata-листе формы могут отрендериться вместе).
   */
  testIdPrefix: string;
  /**
   * Заголовок блока. По умолчанию `archive.games.timeControlLabel`,
   * но форма лобби может передать свой ключ из `archive.lobby.form.*`.
   */
  labelKey?: string;
  labelDefault?: string;
  /** Текст кнопки «Любой». */
  anyLabelKey?: string;
  anyLabelDefault?: string;
}

export function ArchiveTimeControlChips({
  values,
  onChange,
  testIdPrefix,
  labelKey = 'archive.games.timeControlLabel',
  labelDefault = 'Time control',
  anyLabelKey = 'archive.games.timeControlAny',
  anyLabelDefault = 'Any',
}: ArchiveTimeControlChipsProps) {
  const { t } = useTranslation();

  return (
    <div
      className="archive-games-filters__field"
      data-testid={`${testIdPrefix}-time-control`}
    >
      <span className="archive-games-filters__label">
        {t(labelKey, labelDefault)}
      </span>
      <div className="archive-games-filters__presets">
        <button
          type="button"
          className={`archive-games-filters__preset${values.length === 0 ? ' is-active' : ''}`}
          onClick={() => onChange([])}
          data-testid={`${testIdPrefix}-time-control-any`}
        >
          {t(anyLabelKey, anyLabelDefault)}
        </button>
        {TIME_CONTROL_PRESETS.map((cat) => {
          const active = values.includes(cat);
          return (
            <button
              key={cat}
              type="button"
              className={`archive-games-filters__preset${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() => {
                const next = active
                  ? values.filter((c) => c !== cat)
                  : [...values, cat];
                onChange(next);
              }}
              data-testid={`${testIdPrefix}-time-control-${cat}`}
            >
              {t(`archive.games.timeControl_${cat}`, cat)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
