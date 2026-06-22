import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { LiveGamesResponse, LiveGameItem } from '@kingside/shared';
import { PageSeo } from '../components/seo/PageSeo';

// KS-4519. Задержка между вводом символа и применением фильтра — чтобы
// каждое нажатие клавиши не дёргало `/games/live`. 300мс — обычный
// порог для live-search'а в проекте (см. ArchiveGamesPage).
const PLAYER_FILTER_DEBOUNCE_MS = 300;

const TC_FILTERS = ['all', 'bullet', 'blitz', 'rapid', 'classical'] as const;

const TC_LABELS: Record<string, string> = {
  all: '🎯 All',
  bullet: '⚡ Bullet',
  blitz: '🔥 Blitz',
  rapid: '⏱ Rapid',
  classical: '♟ Classical',
};

export function LiveGamesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const typeFilter = searchParams.get('type') ?? 'all';
  const playerFilter = searchParams.get('player') ?? '';

  const [games, setGames] = useState<LiveGameItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadGames = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (playerFilter.trim()) params.set('player', playerFilter.trim());
      const data = await api.get<LiveGamesResponse>(`/games/live?${params}`);
      setGames(Array.isArray(data?.data) ? data.data : []);
      setTotal(data?.total ?? 0);
    } catch {
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, playerFilter]);

  useEffect(() => { loadGames(); }, [loadGames]);

  // Auto-refresh every 15s
  useEffect(() => {
    const interval = setInterval(loadGames, 15000);
    return () => clearInterval(interval);
  }, [loadGames]);

  const setType = useCallback((type: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (type === 'all') next.delete('type'); else next.set('type', type);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setPlayer = useCallback((value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value.trim()) next.set('player', value.trim()); else next.delete('player');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // KS-4519. Контролируемый input + debounce. До правки фильтр
  // обновлялся только на `onBlur`/`Enter` — пользователь печатает «play»,
  // ожидает что список сразу сужается, а ничего не происходит, пока он
  // не уведёт фокус. Теперь — typing-as-you-go с задержкой 300мс.
  const [playerInput, setPlayerInput] = useState<string>(playerFilter);
  // Если фильтр изменился из URL (back/forward, сброс) — синхронизируем
  // локальный input. Сравнение по значению, чтобы не было лишних
  // re-render'ов в обратную сторону через debounce-effect.
  useEffect(() => {
    setPlayerInput((prev) => (prev === playerFilter ? prev : playerFilter));
  }, [playerFilter]);

  const debounceTimerRef = useRef<number | null>(null);
  useEffect(() => {
    // Если значение в input'е совпадает с URL — ничего не делаем
    // (это синхронизация из URL → input, см. эффект выше).
    if (playerInput === playerFilter) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      setPlayer(playerInput);
      debounceTimerRef.current = null;
    }, PLAYER_FILTER_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [playerInput, playerFilter, setPlayer]);

  return (
    <div className="live-games-page">
      <PageSeo ns="games.live" path="/games/live" />
      <h1>{t('liveGames.title')}</h1>

      <div className="live-games-filters">
        <div className="live-games-tc-filters">
          {TC_FILTERS.map((tc) => (
            <button
              key={tc}
              className={`players-rating-btn${typeFilter === tc ? ' active' : ''}`}
              onClick={() => setType(tc)}
            >
              {TC_LABELS[tc]}
            </button>
          ))}
        </div>
        {/* KS-4519. Контролируемый input с debounce'ом — сужает
            список по мере ввода. Enter сразу применяет фильтр без
            ожидания debounce (сбрасывает таймер). */}
        <input
          type="text"
          className="players-search-input"
          placeholder={t('liveGames.filterPlayer')}
          value={playerInput}
          onChange={(e) => setPlayerInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
              }
              setPlayer((e.target as HTMLInputElement).value);
            }
          }}
          data-testid="live-games-player-input"
        />
      </div>

      {loading ? (
        <div className="players-loading">{t('common.loading')}</div>
      ) : games.length === 0 ? (
        <div className="players-empty">{t('liveGames.noGames')}</div>
      ) : (
        <>
          <div className="live-games-count">
            {t('liveGames.count', { count: total })}
          </div>
          <div className="live-games-grid">
            {games.map((game) => (
              <Link
                key={game.id}
                to={`/games/${game.id}/watch`}
                className="live-game-card"
              >
                <div className="live-game-players">
                  <div className="live-game-player white">
                    <span className="live-game-color">♔</span>
                    <span className="live-game-name">{game.white.username}</span>
                    {game.white.rating != null && (
                      <span className="live-game-rating">({game.white.rating})</span>
                    )}
                  </div>
                  <span className="live-game-vs">vs</span>
                  <div className="live-game-player black">
                    <span className="live-game-color">♚</span>
                    <span className="live-game-name">{game.black.username}</span>
                    {game.black.rating != null && (
                      <span className="live-game-rating">({game.black.rating})</span>
                    )}
                  </div>
                </div>
                <div className="live-game-meta">
                  <span className="live-game-tc">{game.timeControl}</span>
                  <span className="live-game-moves">
                    {t('liveGames.moves', { count: game.moveCount })}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
