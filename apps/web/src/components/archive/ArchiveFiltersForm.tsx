import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameResult,
  ArchiveGamesSortMetadata,
  ArchiveTimeControlCategory,
} from '@kingside/shared';
import { ArchiveTimeControlChips } from './ArchiveTimeControlChips';

/**
 * KS-2125: единая форма фильтров архива партий.
 *
 * Используется на трёх страницах:
 *   - `/archive` (лобби, `ArchiveLobbyPage` через `ArchiveSearchForm`):
 *     любое изменение → autoNavigate на `/archive/games?<query>`;
 *   - `/archive/games` (`ArchiveGamesPage`): живое применение через
 *     URL-state (offset reset to 0 при смене фильтра);
 *   - `/archive/players/:slug` (`ArchivePlayerProfilePage`): то же.
 *
 * Поля (все обязательные в одной раскладке):
 *   Sort · Result · Min Elo · Time Control · Since · Until · Player ·
 *   Event · ECO · Min Plies · Max Plies.
 *
 * Текстовые поля debounce'ятся на 400 ms перед onChange — чтобы не
 * дёргать URL/сетевой запрос на каждой клавише. Селекты/чипы
 * применяются мгновенно (выбор бывает явный, пользователю важна
 * обратная связь).
 *
 * `testIdPrefix` — уникальный для конкретной страницы (`archive-metadata-filter`,
 * `archive-search-form`, …); все internal `data-testid` строятся как
 * `${prefix}-<field>`.
 */

export type MetadataResultFilter = ArchiveGameResult | 'any';

export interface ArchiveFiltersValues {
  /** KS-2084: фильтр игроков теперь массив (AND-семантика на бэке). */
  players: string[];
  event: string;
  eco: string;
  result: MetadataResultFilter;
  minElo: number | null;
  /** ISO-дата `YYYY-MM-DD` или пустая строка. */
  since: string;
  /** ISO-дата `YYYY-MM-DD` или пустая строка. */
  until: string;
  minPly: number | null;
  maxPly: number | null;
  sort: ArchiveGamesSortMetadata;
  /**
   * KS-2115. Категории контроля времени для фильтра. Пустой массив —
   * «любой» (фильтр не применяется). Несколько значений — OR на бэке
   * (`?timeControlCategory=classical&timeControlCategory=rapid`).
   */
  timeControlCategory: ArchiveTimeControlCategory[];
}

export const EMPTY_FILTERS: ArchiveFiltersValues = {
  players: [],
  event: '',
  eco: '',
  result: 'any',
  minElo: null,
  since: '',
  until: '',
  minPly: null,
  maxPly: null,
  sort: 'recent',
  timeControlCategory: [],
};

interface ArchiveFiltersFormProps {
  values: ArchiveFiltersValues;
  onChange: (next: ArchiveFiltersValues) => void;
  /**
   * Если передан — рендерится кнопка «Сбросить все». Иначе сброс
   * остаётся на ответственности страницы (например, через
   * empty-state «Reset filters»).
   */
  onReset?: () => void;
  /** Префикс для всех `data-testid` внутри формы. */
  testIdPrefix?: string;
}

const MIN_ELO_PRESETS: number[] = [2000, 2200, 2400, 2600];
const TEXT_DEBOUNCE_MS = 400;

function nullableNumberInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ArchiveFiltersForm({
  values,
  onChange,
  onReset,
  testIdPrefix = 'archive-filters-form',
}: ArchiveFiltersFormProps) {
  const { t } = useTranslation();

  // Локальные drafts для текстовых полей (debounce). Players — отдельно
  // (раскладка multi-chip + Enter add).
  const [playerInput, setPlayerInput] = useState('');
  const [eventDraft, setEventDraft] = useState(values.event);
  const [ecoDraft, setEcoDraft] = useState(values.eco);
  const [minPlyDraft, setMinPlyDraft] = useState(
    values.minPly === null ? '' : String(values.minPly),
  );
  const [maxPlyDraft, setMaxPlyDraft] = useState(
    values.maxPly === null ? '' : String(values.maxPly),
  );

  const eventTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ecoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minPlyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxPlyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Синхронизация drafts с values при внешнем сбросе/смене URL.
  useEffect(() => setEventDraft(values.event), [values.event]);
  useEffect(() => setEcoDraft(values.eco), [values.eco]);
  useEffect(() => {
    setMinPlyDraft(values.minPly === null ? '' : String(values.minPly));
  }, [values.minPly]);
  useEffect(() => {
    setMaxPlyDraft(values.maxPly === null ? '' : String(values.maxPly));
  }, [values.maxPly]);

  useEffect(
    () => () => {
      if (eventTimerRef.current) clearTimeout(eventTimerRef.current);
      if (ecoTimerRef.current) clearTimeout(ecoTimerRef.current);
      if (minPlyTimerRef.current) clearTimeout(minPlyTimerRef.current);
      if (maxPlyTimerRef.current) clearTimeout(maxPlyTimerRef.current);
    },
    [],
  );

  const apply = (patch: Partial<ArchiveFiltersValues>) => {
    onChange({ ...values, ...patch });
  };

  const debounceText = (
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
    value: string,
    transform: (v: string) => string,
    fieldKey: keyof ArchiveFiltersValues,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      apply({ [fieldKey]: transform(value) } as Partial<ArchiveFiltersValues>);
    }, TEXT_DEBOUNCE_MS);
  };

  const tid = (suffix: string) => `${testIdPrefix}-${suffix}`;

  return (
    <div className="archive-games-filters" data-testid={testIdPrefix}>
      {/* Sort */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.sortLabel', 'Sort')}
        </span>
        <select
          className="archive-games-filters__select"
          value={values.sort}
          onChange={(e) =>
            apply({ sort: e.target.value as ArchiveGamesSortMetadata })
          }
          data-testid={tid('sort')}
        >
          <option value="recent">
            {t('archive.games.sortRecent', 'Recent')}
          </option>
          <option value="topElo">
            {t('archive.games.sortTopElo', 'Top Elo')}
          </option>
          <option value="oldest">
            {t('archive.games.sortOldest', 'Oldest first')}
          </option>
        </select>
      </label>

      {/* Result */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.resultLabel', 'Result')}
        </span>
        <select
          className="archive-games-filters__select"
          value={values.result}
          onChange={(e) =>
            apply({ result: e.target.value as MetadataResultFilter })
          }
          data-testid={tid('result')}
        >
          <option value="any">{t('archive.games.resultAny', 'Any')}</option>
          <option value="1-0">
            {t('archive.games.resultWhite', 'White wins')}
          </option>
          <option value="0-1">
            {t('archive.games.resultBlack', 'Black wins')}
          </option>
          <option value="1/2-1/2">
            {t('archive.games.resultDraw', 'Draw')}
          </option>
        </select>
      </label>

      {/* Min Elo */}
      <div className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.minEloLabel', 'Min Elo')}
        </span>
        <div className="archive-games-filters__presets">
          <button
            type="button"
            className={`archive-games-filters__preset${values.minElo === null ? ' is-active' : ''}`}
            onClick={() => apply({ minElo: null })}
            data-testid={tid('min-elo-any')}
          >
            {t('archive.games.minEloAny', 'Any')}
          </button>
          {MIN_ELO_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`archive-games-filters__preset${values.minElo === n ? ' is-active' : ''}`}
              onClick={() => apply({ minElo: n })}
              data-testid={tid(`min-elo-${n}`)}
            >
              {n}+
            </button>
          ))}
        </div>
      </div>

      {/* Time control (KS-2115/KS-2122). */}
      <ArchiveTimeControlChips
        values={values.timeControlCategory}
        onChange={(next) => apply({ timeControlCategory: next })}
        testIdPrefix={testIdPrefix}
      />

      {/* Date range */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.sinceLabel', 'Since')}
        </span>
        <input
          type="date"
          className="archive-games-filters__input"
          value={values.since}
          onChange={(e) => apply({ since: e.target.value })}
          data-testid={tid('since')}
        />
      </label>
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.untilLabel', 'Until')}
        </span>
        <input
          type="date"
          className="archive-games-filters__input"
          value={values.until}
          onChange={(e) => apply({ until: e.target.value })}
          data-testid={tid('until')}
        />
      </label>

      {/* Players (multi). */}
      <div
        className="archive-games-filters__field archive-games-filters__field--players"
        data-testid={tid('players')}
      >
        <span className="archive-games-filters__label">
          {t('archive.games.playerLabel', 'Player')}
        </span>
        {values.players.length > 0 && (
          <ul
            className="archive-games-filters__chips"
            data-testid={tid('players-chips')}
          >
            {values.players.map((p) => (
              <li
                key={p}
                className="archive-games-filters__chip"
                data-testid={tid(`player-chip-${p}`)}
              >
                <span>{p}</span>
                <button
                  type="button"
                  className="archive-games-filters__chip-remove"
                  aria-label={t('archive.games.playerRemove', {
                    defaultValue: 'Remove {{name}}',
                    name: p,
                  })}
                  onClick={() =>
                    apply({ players: values.players.filter((x) => x !== p) })
                  }
                  data-testid={tid(`player-remove-${p}`)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="text"
          className="archive-games-filters__input archive-games-filters__chip-input--solo"
          value={playerInput}
          onChange={(e) => setPlayerInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const v = playerInput.trim();
              if (v.length === 0) return;
              if (
                values.players.some(
                  (p) => p.toLowerCase() === v.toLowerCase(),
                )
              ) {
                setPlayerInput('');
                return;
              }
              apply({ players: [...values.players, v] });
              setPlayerInput('');
            }
          }}
          placeholder={t('archive.games.playerPlaceholder', 'Name…')}
          data-testid={tid('player-input')}
        />
      </div>

      {/* Event */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.eventLabel', 'Event')}
        </span>
        <input
          type="text"
          className="archive-games-filters__input"
          value={eventDraft}
          onChange={(e) => {
            setEventDraft(e.target.value);
            debounceText(
              eventTimerRef,
              e.target.value,
              (v) => v.trim(),
              'event',
            );
          }}
          placeholder={t('archive.games.eventPlaceholder', 'Tournament name…')}
          data-testid={tid('event')}
        />
      </label>

      {/* ECO */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.ecoLabel', 'ECO')}
        </span>
        <input
          type="text"
          className="archive-games-filters__input archive-games-filters__input--eco"
          value={ecoDraft}
          onChange={(e) => {
            setEcoDraft(e.target.value);
            debounceText(
              ecoTimerRef,
              e.target.value,
              (v) => v.trim().toUpperCase(),
              'eco',
            );
          }}
          placeholder="B90"
          maxLength={3}
          data-testid={tid('eco')}
        />
      </label>

      {/* Length (plies) */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.minPlyLabel', 'Min plies')}
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          className="archive-games-filters__input archive-games-filters__input--narrow"
          value={minPlyDraft}
          onChange={(e) => {
            setMinPlyDraft(e.target.value);
            if (minPlyTimerRef.current) clearTimeout(minPlyTimerRef.current);
            minPlyTimerRef.current = setTimeout(() => {
              apply({ minPly: nullableNumberInput(e.target.value) });
            }, TEXT_DEBOUNCE_MS);
          }}
          data-testid={tid('min-ply')}
        />
      </label>
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.maxPlyLabel', 'Max plies')}
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          className="archive-games-filters__input archive-games-filters__input--narrow"
          value={maxPlyDraft}
          onChange={(e) => {
            setMaxPlyDraft(e.target.value);
            if (maxPlyTimerRef.current) clearTimeout(maxPlyTimerRef.current);
            maxPlyTimerRef.current = setTimeout(() => {
              apply({ maxPly: nullableNumberInput(e.target.value) });
            }, TEXT_DEBOUNCE_MS);
          }}
          data-testid={tid('max-ply')}
        />
      </label>

      {onReset && (
        <div className="archive-games-filters__field archive-games-filters__field--reset">
          <button
            type="button"
            className="archive-games-filters__reset"
            onClick={() => {
              setPlayerInput('');
              setEventDraft('');
              setEcoDraft('');
              setMinPlyDraft('');
              setMaxPlyDraft('');
              onReset();
            }}
            data-testid={tid('reset')}
          >
            {t('archive.games.resetAll', 'Reset all')}
          </button>
        </div>
      )}
    </div>
  );
}
