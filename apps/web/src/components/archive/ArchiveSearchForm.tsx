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
  players: string[];
  event: string;
  eco: string;
  sinceYear: string;
  untilYear: string;
  result: ResultFilter;
  minElo: number | null;
  sort: ArchiveGamesSortMetadata;
}

const EMPTY_STATE: FormState = {
  players: [],
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
  // KS-2084: каждый игрок — отдельный `?player=...`. См.
  // metadataFiltersToUrl в ArchiveGamesPage — единая семантика.
  for (const p of state.players) {
    const trimmed = p.trim();
    if (trimmed.length > 0) params.append('player', trimmed);
  }
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
  // KS-2084: отдельный draft для текущего значения autocomplete'а.
  // Когда пользователь выбирает игрока (или жмёт «Add»), имя
  // переезжает в `state.players` chip'ом, а draft очищается, чтобы
  // можно было сразу искать второго игрока («Carlsen» → submit chip
  // → начать набирать «Caruana»).
  const [playerDraft, setPlayerDraft] = useState('');

  const apply = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }));

  const addPlayer = (name: string) => {
    const v = name.trim();
    if (v.length === 0) return;
    if (state.players.some((p) => p.toLowerCase() === v.toLowerCase())) {
      setPlayerDraft('');
      return;
    }
    setState((s) => ({ ...s, players: [...s.players, v] }));
    setPlayerDraft('');
  };

  const removePlayer = (name: string) => {
    setState((s) => ({ ...s, players: s.players.filter((p) => p !== name) }));
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Если в input ещё что-то есть, но не добавлено — добавим перед submit.
    const submitState = (() => {
      const v = playerDraft.trim();
      if (
        v.length === 0 ||
        state.players.some((p) => p.toLowerCase() === v.toLowerCase())
      ) {
        return state;
      }
      return { ...state, players: [...state.players, v] };
    })();
    navigate(buildSearchUrl(submitState));
  };

  const handleReset = () => {
    setState(EMPTY_STATE);
    setPlayerDraft('');
  };

  return (
    <form
      className="archive-lobby__search-form"
      data-testid="archive-search-form"
      onSubmit={handleSubmit}
    >
      <div className="archive-lobby__search-fields">
        <div
          className="archive-games-filters__field archive-games-filters__field--players"
          data-testid="archive-search-form-players"
        >
          {state.players.length > 0 && (
            <ul
              className="archive-games-filters__chips"
              data-testid="archive-search-form-players-chips"
            >
              {state.players.map((p) => (
                <li
                  key={p}
                  className="archive-games-filters__chip"
                  data-testid={`archive-search-form-player-chip-${p}`}
                >
                  <span>{p}</span>
                  <button
                    type="button"
                    className="archive-games-filters__chip-remove"
                    aria-label={t('lobby.form.playerRemove', {
                      defaultValue: 'Remove {{name}}',
                      name: p,
                    })}
                    onClick={() => removePlayer(p)}
                    data-testid={`archive-search-form-player-remove-${p}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="archive-games-filters__chip-input">
            <ArchivePlayerAutocomplete
              value={playerDraft}
              onChange={setPlayerDraft}
              onSelect={(sel) => addPlayer(sel.name)}
            />
            <button
              type="button"
              className="archive-games-filters__chip-add"
              onClick={() => addPlayer(playerDraft)}
              disabled={playerDraft.trim().length === 0}
              data-testid="archive-search-form-player-add"
            >
              {t('lobby.form.playerAdd', 'Add')}
            </button>
          </div>
        </div>

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
