import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameResult,
  ArchiveGamesSortMetadata,
} from '@kingside/shared';

/**
 * KS-2068 (F2): фильтры metadata-режима `/archive/games`.
 *
 * Отдельный компонент от `ArchiveGamesFilters` (by-position): набор
 * полей разный (нет `color`/`move`, добавлены `event`, `until`,
 * `minPly`, `maxPly`, sort расширен `oldest`).
 */

export type MetadataResultFilter = ArchiveGameResult | 'any';

/**
 * KS-2084: фильтр игроков теперь массив. URL хранит несколько
 * `?player=A&player=B`, бэк (KS-2081) на каждом из них делает AND-фильтр
 * (партии, где обе стороны включают указанных игроков). UI отображает
 * добавленных игроков как chips и даёт удалять/добавлять.
 */
export interface ArchiveMetadataFilterValues {
  players: string[];
  event: string;
  eco: string;
  result: MetadataResultFilter;
  minElo: number | null;
  since: string;
  until: string;
  minPly: number | null;
  maxPly: number | null;
  sort: ArchiveGamesSortMetadata;
}

interface ArchiveMetadataFiltersProps {
  values: ArchiveMetadataFilterValues;
  onChange: (next: ArchiveMetadataFilterValues) => void;
}

const MIN_ELO_PRESETS: number[] = [2000, 2200, 2400, 2600];
const TEXT_DEBOUNCE_MS = 400;

export const EMPTY_METADATA_FILTERS: ArchiveMetadataFilterValues = {
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
};

function nullableNumberInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ArchiveMetadataFilters({
  values,
  onChange,
}: ArchiveMetadataFiltersProps) {
  const { t } = useTranslation();

  // Локальные drafts для текстовых полей с debounce — чтобы не
  // дёргать URL/сетевой запрос на каждой клавише.
  // KS-2084: для players используется отдельный input как «add new».
  // По Enter / клику Add — добавляется chip в `values.players` через
  // `apply({ players: [...] })`. Сами chips — derived от values.players.
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

  const apply = (patch: Partial<ArchiveMetadataFilterValues>) => {
    onChange({ ...values, ...patch });
  };

  const debounceText = (
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
    value: string,
    transform: (v: string) => string,
    fieldKey: keyof ArchiveMetadataFilterValues,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      apply({ [fieldKey]: transform(value) } as Partial<ArchiveMetadataFilterValues>);
    }, TEXT_DEBOUNCE_MS);
  };

  return (
    <div
      className="archive-games-filters"
      data-testid="archive-metadata-filters"
    >
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
          data-testid="archive-metadata-filter-sort"
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
          data-testid="archive-metadata-filter-result"
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
            data-testid="archive-metadata-filter-min-elo-any"
          >
            {t('archive.games.minEloAny', 'Any')}
          </button>
          {MIN_ELO_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`archive-games-filters__preset${values.minElo === n ? ' is-active' : ''}`}
              onClick={() => apply({ minElo: n })}
              data-testid={`archive-metadata-filter-min-elo-${n}`}
            >
              {n}+
            </button>
          ))}
        </div>
      </div>

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
          data-testid="archive-metadata-filter-since"
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
          data-testid="archive-metadata-filter-until"
        />
      </label>

      {/* Players (multi, KS-2084).
          UI: input + Add-кнопка → новый chip; chip имеет крестик
          для удаления. Enter в input тоже добавляет. Дубликаты
          (case-insensitive) игнорируются. */}
      <div
        className="archive-games-filters__field archive-games-filters__field--players"
        data-testid="archive-metadata-filter-players"
      >
        <span className="archive-games-filters__label">
          {t('archive.games.playerLabel', 'Player')}
        </span>
        {values.players.length > 0 && (
          <ul
            className="archive-games-filters__chips"
            data-testid="archive-metadata-filter-players-chips"
          >
            {values.players.map((p) => (
              <li
                key={p}
                className="archive-games-filters__chip"
                data-testid={`archive-metadata-filter-player-chip-${p}`}
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
                  data-testid={`archive-metadata-filter-player-remove-${p}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* KS-2092: кнопка «Add» удалена. Способы добавить chip:
            — Enter в input (если в нём есть непустой draft);
            — submit формы (родитель сам подхватит draft, см.
              ArchiveGamesPage / ArchiveSearchForm).
            На этой странице (metadata-фильтры в /archive/games) нет
            явного submit — список перерисовывается на каждое
            изменение URL. Поэтому здесь Enter — основной триггер. */}
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
          data-testid="archive-metadata-filter-player-input"
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
          data-testid="archive-metadata-filter-event"
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
          data-testid="archive-metadata-filter-eco"
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
          data-testid="archive-metadata-filter-min-ply"
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
          data-testid="archive-metadata-filter-max-ply"
        />
      </label>
    </div>
  );
}
