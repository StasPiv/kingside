import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type {
  TopPlayersResponse,
  OnlinePlayersResponse,
  SearchPlayersResponse,
  RatingType,
  TopPlayerItem,
  OnlinePlayerItem,
  SearchPlayerItem,
} from '@kingside/shared';

type Tab = 'top' | 'online' | 'search';

const RATING_TYPES: RatingType[] = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'];

const RATING_LABELS: Record<RatingType, string> = {
  bullet: '⚡ Bullet',
  blitz: '🔥 Blitz',
  rapid: '⏱ Rapid',
  classical: '♟ Classical',
  puzzle: '🧩 Puzzle',
};

const VALID_TABS: Tab[] = ['top', 'online', 'search'];

function isValidTab(v: string | null): v is Tab {
  return v != null && VALID_TABS.includes(v as Tab);
}

function isValidRatingType(v: string | null): v is RatingType {
  return v != null && RATING_TYPES.includes(v as RatingType);
}

export function PlayersPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const typeParam = searchParams.get('type');
  const tab: Tab = isValidTab(tabParam) ? tabParam : 'top';
  const ratingType: RatingType = isValidRatingType(typeParam) ? typeParam : 'blitz';

  const setTab = useCallback((newTab: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      if (newTab !== 'top') next.delete('type');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setRatingType = useCallback((newType: RatingType) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'top');
      next.set('type', newType);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [topPlayers, setTopPlayers] = useState<TopPlayerItem[]>([]);
  const [topTotal, setTopTotal] = useState(0);
  const [topLoading, setTopLoading] = useState(false);
  const [topLoadingMore, setTopLoadingMore] = useState(false);

  // Online players state
  const [onlinePlayers, setOnlinePlayers] = useState<OnlinePlayerItem[]>([]);
  const [onlineTotal, setOnlineTotal] = useState(0);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineLoadingMore, setOnlineLoadingMore] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchPlayerItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDone, setSearchDone] = useState(false);

  const PAGE_SIZE = 50;

  // Load top players
  const loadTop = useCallback(async (type: RatingType) => {
    setTopLoading(true);
    try {
      const data = await api.get<TopPlayersResponse>(`/api/players/top?type=${type}&limit=${PAGE_SIZE}`);
      setTopPlayers(data.data);
      setTopTotal(data.total);
    } catch {
      setTopPlayers([]);
    } finally {
      setTopLoading(false);
    }
  }, []);

  const topSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab !== 'top' || topPlayers.length >= topTotal || topLoading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !topLoadingMore && topPlayers.length < topTotal) {
          setTopLoadingMore(true);
          api.get<TopPlayersResponse>(`/api/players/top?type=${ratingType}&limit=${PAGE_SIZE}&offset=${topPlayers.length}`)
            .then((data) => {
              setTopPlayers((prev) => [...prev, ...data.data]);
              setTopTotal(data.total);
            })
            .catch(() => {})
            .finally(() => setTopLoadingMore(false));
        }
      },
      { threshold: 0.1 },
    );
    const el = topSentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [tab, topPlayers.length, topTotal, topLoadingMore, topLoading, ratingType]);

  // Load online players
  const loadOnline = useCallback(async () => {
    setOnlineLoading(true);
    try {
      const data = await api.get<OnlinePlayersResponse>(`/api/players/online?limit=${PAGE_SIZE}`);
      setOnlinePlayers(data.data);
      setOnlineTotal(data.total);
    } catch {
      setOnlinePlayers([]);
    } finally {
      setOnlineLoading(false);
    }
  }, []);

  const onlineSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab !== 'online' || onlinePlayers.length >= onlineTotal || onlineLoading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !onlineLoadingMore && onlinePlayers.length < onlineTotal) {
          setOnlineLoadingMore(true);
          api.get<OnlinePlayersResponse>(`/api/players/online?limit=${PAGE_SIZE}&offset=${onlinePlayers.length}`)
            .then((data) => {
              setOnlinePlayers((prev) => [...prev, ...data.data]);
              setOnlineTotal(data.total);
            })
            .catch(() => {})
            .finally(() => setOnlineLoadingMore(false));
        }
      },
      { threshold: 0.1 },
    );
    const el = onlineSentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [tab, onlinePlayers.length, onlineTotal, onlineLoadingMore, onlineLoading]);

  // Load on tab/type change
  useEffect(() => {
    if (tab === 'top') loadTop(ratingType);
    if (tab === 'online') loadOnline();
  }, [tab, ratingType, loadTop, loadOnline]);

  // Search with debounce
  useEffect(() => {
    if (tab !== 'search') return;
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setSearchDone(false);
      return;
    }

    const timeout = setTimeout(async () => {
      setSearchLoading(true);
      setSearchDone(false);
      try {
        const data = await api.get<SearchPlayersResponse>(
          `/api/players/search?q=${encodeURIComponent(searchQuery.trim())}&limit=20`,
        );
        setSearchResults(data.data);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
        setSearchDone(true);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [tab, searchQuery]);

  return (
    <div className="players-page">
      <h1>{t('players.title')}</h1>

      <div className="players-tabs">
        <button
          className={`players-tab${tab === 'top' ? ' active' : ''}`}
          onClick={() => setTab('top')}
        >
          {t('players.tabTop')}
        </button>
        <button
          className={`players-tab${tab === 'online' ? ' active' : ''}`}
          onClick={() => setTab('online')}
        >
          {t('players.tabOnline')}
        </button>
        <button
          className={`players-tab${tab === 'search' ? ' active' : ''}`}
          onClick={() => setTab('search')}
        >
          {t('players.tabSearch')}
        </button>
      </div>

      {/* Top Players Tab */}
      {tab === 'top' && (
        <div className="players-section">
          <div className="players-rating-types">
            {RATING_TYPES.map((rt) => (
              <button
                key={rt}
                className={`players-rating-btn${ratingType === rt ? ' active' : ''}`}
                onClick={() => setRatingType(rt)}
              >
                {RATING_LABELS[rt]}
              </button>
            ))}
          </div>

          {topLoading ? (
            <div className="players-loading">{t('common.loading')}</div>
          ) : (
            <>
              <table className="players-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('players.username')}</th>
                    {ratingType === 'puzzle' ? (
                      <>
                        <th>{t('players.best3')}</th>
                        <th>{t('players.best5')}</th>
                      </>
                    ) : (
                      <>
                        <th>{t('players.rating')}</th>
                        <th>{t('players.games')}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {topPlayers.map((p) => (
                    <tr key={p.id}>
                      <td className="players-rank">{p.rank}</td>
                      <td>
                        <Link to={`/player/${p.username}`} className="players-link">
                          {p.username}
                        </Link>
                      </td>
                      {ratingType === 'puzzle' ? (
                        <>
                          <td className="players-rating">{p.puzzleRush?.best3 ?? 0}</td>
                          <td className="players-rating">{p.puzzleRush?.best5 ?? 0}</td>
                        </>
                      ) : (
                        <>
                          <td className="players-rating">{p.rating}</td>
                          <td className="players-games">{p.gamesPlayed}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {topPlayers.length === 0 && (
                <div className="players-empty">{t('players.noPlayers')}</div>
              )}
              {topTotal > 0 && (
                <div className="players-total">
                  {t('players.showing', { count: topPlayers.length, total: topTotal })}
                </div>
              )}
              {topPlayers.length < topTotal && (
                <div ref={topSentinelRef} className="players-load-more">
                  {topLoadingMore && <span>{t('common.loading')}</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Online Players Tab */}
      {tab === 'online' && (
        <div className="players-section">
          {onlineLoading ? (
            <div className="players-loading">{t('common.loading')}</div>
          ) : (
            <>
              <div className="players-online-count">
                {t('players.onlineCount', { count: onlineTotal })}
              </div>
              <table className="players-table">
                <thead>
                  <tr>
                    <th>{t('players.username')}</th>
                    <th>⚡</th>
                    <th>🔥</th>
                    <th>⏱</th>
                    <th>♟</th>
                  </tr>
                </thead>
                <tbody>
                  {onlinePlayers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/player/${p.username}`} className="players-link">
                          {p.username}
                        </Link>
                        {(p as unknown as { isBot?: boolean }).isBot && <span className="bot-badge">BOT</span>}
                      </td>
                      <td className="players-rating">{p.ratingBullet}</td>
                      <td className="players-rating">{p.ratingBlitz}</td>
                      <td className="players-rating">{p.ratingRapid}</td>
                      <td className="players-rating">{p.ratingClassical}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {onlinePlayers.length === 0 && (
                <div className="players-empty">{t('players.noOnline')}</div>
              )}
              {onlinePlayers.length < onlineTotal && (
                <div ref={onlineSentinelRef} className="players-load-more">
                  {onlineLoadingMore && <span>{t('common.loading')}</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Search Tab */}
      {tab === 'search' && (
        <div className="players-section">
          <input
            type="text"
            className="players-search-input"
            placeholder={t('players.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />

          {searchLoading && (
            <div className="players-loading">{t('common.loading')}</div>
          )}

          {!searchLoading && searchResults.length > 0 && (
            <table className="players-table">
              <thead>
                <tr>
                  <th>{t('players.username')}</th>
                  <th>⚡</th>
                  <th>🔥</th>
                  <th>⏱</th>
                  <th>♟</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/player/${p.username}`} className="players-link">
                        {p.username}
                      </Link>
                      {(p as unknown as { isBot?: boolean }).isBot && <span className="bot-badge">BOT</span>}
                    </td>
                    <td className="players-rating">{p.ratingBullet}</td>
                    <td className="players-rating">{p.ratingBlitz}</td>
                    <td className="players-rating">{p.ratingRapid}</td>
                    <td className="players-rating">{p.ratingClassical}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!searchLoading && searchDone && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
            <div className="players-empty">{t('players.noResults')}</div>
          )}

          {!searchLoading && searchQuery.trim().length < 2 && (
            <div className="players-empty players-search-hint">{t('players.searchHint')}</div>
          )}
        </div>
      )}
    </div>
  );
}
