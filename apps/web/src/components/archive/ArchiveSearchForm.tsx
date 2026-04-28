import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGameResult,
  ArchiveGamesSortMetadata,
} from '@kingside/shared';
import { ArchivePlayerAutocomplete } from './ArchivePlayerAutocomplete';
import { ArchiveEventAutocomplete } from './ArchiveEventAutocomplete';

/**
 * KS-2067 (F1): форма поиска на лобби `/archive`.
 *
 * Поля: player (autocomplete), event (autocomplete), eco, since/until
 * (year picker — обычный `<input type="number">` с валидацией 1850..now+1
 * на бэке отдаём как `YYYY-01-01`/`YYYY-12-31`), result, minElo, sort.
 *
 * Submit → `navigate('/archive/games?<query>')` (F2-страница списка
 * читает фильтры из URL).
 */

type ResultFilter = ArchiveGameResult | 'any';
const VALID_RESULTS: readonly ResultFilter[] = [
  'any',
  '1-0',
  '0-1',
  '1/2-1/2',
];
const MIN_ELO_PRESETS = [2000, 2200, 2400, 2600] as const;
const SORTS: readonly ArchiveGamesSortMetadata[] = [
  'recent',
  'topElo',
  'oldest',
];

interface FormState {
  player: string;
  event: string;
  eco: string;
  sinceYear: string;
  untilYear: string;
  result: ResultFilter;
  minElo: number | null;
  sort: ArchiveGamesSortMetadata;
}

const EMPTY_STATE: FormState = {
  player: '',
  event: '',
  eco: '',
  sinceYear: '',
  untilYear: '',
  result: 'any',
  minElo: null,
  sort: 'recent',
};

function buildSearchUrl(state: FormState): string {
  const params = new URLSearchParams();
  if (state.player) params.set('player', state.player);
  if (state.event) params.set('event', state.event);
  if (state.eco) params.set('eco', state.eco.trim().toUpperCase());
  if (state.sinceYear) params.set('since', `${state.sinceYear}-01-01`);
  if (state.untilYear) params.set('until', `${state.untilYear}-12-31`);
  if (state.result !== 'any') params.set('result', state.result);
  if (state.minElo !== null) params.set('minElo', String(state.minElo));
  if (state.sort !== 'recent') params.set('sort', state.sort);
  const qs = params.toString();
  return qs ? `/archive/games?${qs}` : '/archive/games';
}

export function ArchiveSearchForm() {
  const { t } = useTranslation('archive');
  const navigate = useNavigate();
  const [state, setState] = useState<FormState>(EMPTY_STATE);

  const apply = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }));

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    navigate(buildSearchUrl(state));
  };

  const handleReset = () => setState(EMPTY_STATE);

  return (
    <form
      className="archive-lobby__search-form"
      data-testid="archive-search-form"
      onSubmit={handleSubmit}
    >
      <div className="archive-lobby__search-fields">
        <ArchivePlayerAutocomplete
          value={state.player}
          onChange={(v) => apply({ player: v })}
          onSelect={(sel) => apply({ player: sel.name })}
        />

        <ArchiveEventAutocomplete
          value={state.event}
          onChange={(v) => apply({ event: v })}
          onSelect={(sel) => apply({ event: sel.name })}
        />

        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.ecoLabel', 'ECO')}
          </span>
          <input
            type="text"
            className="archive-games-filters__input archive-games-filters__input--eco"
            value={state.eco}
            placeholder="B90"
            maxLength={3}
            data-testid="archive-search-form-eco"
            onChange={(e) => apply({ eco: e.target.value })}
          />
        </label>

        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.sinceYearLabel', 'From year')}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1850}
            max={new Date().getFullYear() + 1}
            className="archive-games-filters__input archive-games-filters__input--narrow"
            value={state.sinceYear}
            data-testid="archive-search-form-since-year"
            onChange={(e) => apply({ sinceYear: e.target.value })}
          />
        </label>

        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.untilYearLabel', 'To year')}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1850}
            max={new Date().getFullYear() + 1}
            className="archive-games-filters__input archive-games-filters__input--narrow"
            value={state.untilYear}
            data-testid="archive-search-form-until-year"
            onChange={(e) => apply({ untilYear: e.target.value })}
          />
        </label>

        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.resultLabel', 'Result')}
          </span>
          <select
            className="archive-games-filters__select"
            value={state.result}
            data-testid="archive-search-form-result"
            onChange={(e) => {
              const v = e.target.value as ResultFilter;
              apply({
                result: VALID_RESULTS.includes(v) ? v : 'any',
              });
            }}
          >
            <option value="any">{t('lobby.form.resultAny', 'Any')}</option>
            <option value="1-0">{t('lobby.form.resultWhite', 'White wins')}</option>
            <option value="0-1">{t('lobby.form.resultBlack', 'Black wins')}</option>
            <option value="1/2-1/2">{t('lobby.form.resultDraw', 'Draw')}</option>
          </select>
        </label>

        <div className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.minEloLabel', 'Min Elo')}
          </span>
          <div className="archive-games-filters__presets">
            <button
              type="button"
              className={`archive-games-filters__preset${state.minElo === null ? ' is-active' : ''}`}
              onClick={() => apply({ minElo: null })}
              data-testid="archive-search-form-min-elo-any"
            >
              {t('lobby.form.minEloAny', 'Any')}
            </button>
            {MIN_ELO_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={`archive-games-filters__preset${state.minElo === n ? ' is-active' : ''}`}
                onClick={() => apply({ minElo: n })}
                data-testid={`archive-search-form-min-elo-${n}`}
              >
                {n}+
              </button>
            ))}
          </div>
        </div>

        <label className="archive-games-filters__field">
          <span className="archive-games-filters__label">
            {t('lobby.form.sortLabel', 'Sort')}
          </span>
          <select
            className="archive-games-filters__select"
            value={state.sort}
            data-testid="archive-search-form-sort"
            onChange={(e) => {
              const v = e.target.value as ArchiveGamesSortMetadata;
              apply({
                sort: SORTS.includes(v) ? v : 'recent',
              });
            }}
          >
            <option value="recent">{t('lobby.form.sortRecent', 'Recent')}</option>
            <option value="topElo">{t('lobby.form.sortTopElo', 'Top Elo')}</option>
            <option value="oldest">{t('lobby.form.sortOldest', 'Oldest first')}</option>
          </select>
        </label>
      </div>

      <div className="archive-lobby__search-actions">
        <button
          type="submit"
          className="archive-lobby__search-submit"
          data-testid="archive-search-form-submit"
        >
          {t('lobby.form.submit', 'Search')}
        </button>
        <button
          type="button"
          className="archive-lobby__search-reset"
          data-testid="archive-search-form-reset"
          onClick={handleReset}
        >
          {t('lobby.form.reset', 'Reset')}
        </button>
      </div>
    </form>
  );
}

// Экспортируем хелпер для unit-тестов URL-сборки.
export { buildSearchUrl as __buildSearchUrl };
