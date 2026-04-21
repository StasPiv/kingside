import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { WorkshopGameListItem } from './WorkshopGameListItem';

type GameItem = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw' | null;
  opponent: { id: string; username: string; ratingBefore: number | null };
  result: string;
  timeControl: string;
  timeControlType: string | null;
  totalMoves: number;
  createdAt: string;
  ecoCode: string | null;
  openingName: string | null;
};

type GamesResponse = {
  data: GameItem[];
  total: number;
  hasMore: boolean;
};

const PAGE_SIZE = 20;

export function WorkshopMyGames() {
  const { t } = useTranslation();
  const [games, setGames] = useState<GameItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  const loadGames = useCallback(async (offset: number) => {
    setLoading(true);
    setError(false);
    try {
      const data = await api.get<GamesResponse>(
        `/games/my?take=${PAGE_SIZE}&skip=${offset}`
      );
      setGames(data.data);
      setHasMore(data.hasMore);
      setTotal(data.total);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGames(0);
  }, [loadGames]);

  const handlePrev = () => {
    const newSkip = Math.max(0, skip - PAGE_SIZE);
    setSkip(newSkip);
    loadGames(newSkip);
  };

  const handleNext = () => {
    const newSkip = skip + PAGE_SIZE;
    setSkip(newSkip);
    loadGames(newSkip);
  };

  const currentPage = Math.floor(skip / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">{t('workshop.myGames.title')}</h2>

      {loading && (
        <p className="workshop-section-block__loading">{t('common.loading')}</p>
      )}

      {error && !loading && (
        <p className="workshop-section-block__error">{t('workshop.myGames.error')}</p>
      )}

      {!loading && !error && games.length === 0 && (
        <p className="workshop-section-block__empty">{t('workshop.myGames.empty')}</p>
      )}

      {!loading && !error && games.length > 0 && (
        <>
          <div className="workshop-games-list">
            {games.map((game) => (
              <WorkshopGameListItem key={game.id} game={game} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="workshop-pagination">
              <button
                className="workshop-pagination__btn"
                onClick={handlePrev}
                disabled={skip === 0}
              >
                {t('workshop.myGames.prev')}
              </button>
              <span className="workshop-pagination__info">
                {t('workshop.myGames.page', { current: currentPage, total: totalPages })}
              </span>
              <button
                className="workshop-pagination__btn"
                onClick={handleNext}
                disabled={!hasMore}
              >
                {t('workshop.myGames.next')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
