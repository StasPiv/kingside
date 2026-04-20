import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameColor,
  ArchiveGameResult,
  ArchiveGamesSort,
} from '@kingside/shared';

export type ResultFilterValue = ArchiveGameResult | 'any';
export type ColorFilterValue = ArchiveGameColor;

export type SinceFilterValue = '1y' | '5y' | 'all';

export interface ArchiveGamesFilterValues {
  sort: ArchiveGamesSort;
  result: ResultFilterValue;
  minElo: number | null;
  since: SinceFilterValue;
  color: ColorFilterValue;
  player: string;
  eco: string;
}

interface ArchiveGamesFiltersProps {
  values: ArchiveGamesFilterValues;
  onChange: (next: ArchiveGamesFilterValues) => void;
}

const MIN_ELO_PRESETS: number[] = [2000, 2200, 2400, 2600];
const PLAYER_DEBOUNCE_MS = 400;
const ECO_DEBOUNCE_MS = 400;

/**
 * Filters panel for the games-by-position page.
 *
 * Structural markup only (styling in KS-1614). Text inputs
 * (player, eco) debounce changes for 400ms before propagating
 * to the parent to avoid re-querying on every keystroke.
 *
 * Select / preset changes are applied immediately — the page's
 * hook still debounces fetches at the network layer.
 */
export function ArchiveGamesFilters({ values, onChange }: ArchiveGamesFiltersProps) {
  const { t } = useTranslation();

  // Local buffers for text inputs (debounced against parent onChange).
  const [playerDraft, setPlayerDraft] = useState(values.player);
  const [ecoDraft, setEcoDraft] = useState(values.eco);

  const playerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ecoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep drafts in sync when parent resets/changes values externally
  // (e.g. navigation updates the query-string).
  useEffect(() => {
    setPlayerDraft(values.player);
  }, [values.player]);

  useEffect(() => {
    setEcoDraft(values.eco);
  }, [values.eco]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      if (playerTimerRef.current) clearTimeout(playerTimerRef.current);
      if (ecoTimerRef.current) clearTimeout(ecoTimerRef.current);
    },
    [],
  );

  const apply = (patch: Partial<ArchiveGamesFilterValues>) => {
    onChange({ ...values, ...patch });
  };

  const onPlayerDraftChange = (v: string) => {
    setPlayerDraft(v);
    if (playerTimerRef.current) clearTimeout(playerTimerRef.current);
    playerTimerRef.current = setTimeout(() => {
      apply({ player: v.trim() });
    }, PLAYER_DEBOUNCE_MS);
  };

  const onEcoDraftChange = (v: string) => {
    setEcoDraft(v);
    if (ecoTimerRef.current) clearTimeout(ecoTimerRef.current);
    ecoTimerRef.current = setTimeout(() => {
      apply({ eco: v.trim().toUpperCase() });
    }, ECO_DEBOUNCE_MS);
  };

  return (
    <div className="archive-games-filters" data-testid="archive-games-filters">
      {/* Sort */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.sortLabel', 'Sort')}
        </span>
        <select
          className="archive-games-filters__select"
          value={values.sort}
          onChange={(e) => apply({ sort: e.target.value as ArchiveGamesSort })}
          data-testid="archive-games-filter-sort"
        >
          <option value="recent">{t('archive.games.sortRecent', 'Recent')}</option>
          <option value="topElo">{t('archive.games.sortTopElo', 'Top Elo')}</option>
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
          onChange={(e) => apply({ result: e.target.value as ResultFilterValue })}
          data-testid="archive-games-filter-result"
        >
          <option value="any">{t('archive.games.resultAny', 'Any')}</option>
          <option value="1-0">{t('archive.games.resultWhite', 'White wins')}</option>
          <option value="0-1">{t('archive.games.resultBlack', 'Black wins')}</option>
          <option value="1/2-1/2">{t('archive.games.resultDraw', 'Draw')}</option>
        </select>
      </label>

      {/* Min Elo presets */}
      <div className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.minEloLabel', 'Min Elo')}
        </span>
        <div className="archive-games-filters__presets">
          <button
            type="button"
            className={`archive-games-filters__preset${values.minElo === null ? ' is-active' : ''}`}
            onClick={() => apply({ minElo: null })}
            data-testid="archive-games-filter-min-elo-any"
          >
            {t('archive.games.minEloAny', 'Any')}
          </button>
          {MIN_ELO_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`archive-games-filters__preset${values.minElo === n ? ' is-active' : ''}`}
              onClick={() => apply({ minElo: n })}
              data-testid={`archive-games-filter-min-elo-${n}`}
            >
              {n}+
            </button>
          ))}
        </div>
      </div>

      {/* Since */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.sinceLabel', 'Since')}
        </span>
        <select
          className="archive-games-filters__select"
          value={values.since}
          onChange={(e) => apply({ since: e.target.value as SinceFilterValue })}
          data-testid="archive-games-filter-since"
        >
          <option value="all">{t('archive.games.sinceAll', 'All time')}</option>
          <option value="5y">{t('archive.games.since5y', 'Last 5 years')}</option>
          <option value="1y">{t('archive.games.since1y', 'Last year')}</option>
        </select>
      </label>

      {/* Colour */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.colorLabel', 'Colour')}
        </span>
        <select
          className="archive-games-filters__select"
          value={values.color}
          onChange={(e) => apply({ color: e.target.value as ColorFilterValue })}
          data-testid="archive-games-filter-color"
        >
          <option value="any">{t('archive.games.colorAny', 'Any')}</option>
          <option value="white">{t('archive.games.colorWhite', 'White')}</option>
          <option value="black">{t('archive.games.colorBlack', 'Black')}</option>
        </select>
      </label>

      {/* Player */}
      <label className="archive-games-filters__field">
        <span className="archive-games-filters__label">
          {t('archive.games.playerLabel', 'Player')}
        </span>
        <input
          type="text"
          className="archive-games-filters__input"
          value={playerDraft}
          onChange={(e) => onPlayerDraftChange(e.target.value)}
          placeholder={t('archive.games.playerPlaceholder', 'Name…')}
          data-testid="archive-games-filter-player"
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
          onChange={(e) => onEcoDraftChange(e.target.value)}
          placeholder="B90"
          maxLength={3}
          data-testid="archive-games-filter-eco"
        />
      </label>
    </div>
  );
}
