import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ArchiveGameSummary } from '@kingside/shared';
import { archiveApi } from '../../api/archive';
import { ArchiveGameRow } from './ArchiveGameRow';

/**
 * KS-2067 (F1): блок «Recent games» на лобби `/archive`. Грузит 10
 * самых последних партий через `archiveApi.getArchiveGamesMetadata({
 * sort: 'recent', limit: 10 })`. Клик по строке → `/archive/games/:id`
 * (F4). Используется универсальная строка `<ArchiveGameRow>` (F2).
 */

const LIMIT = 10;
const SKELETON_ROWS = 10;

export function ArchiveRecentGamesBlock() {
  const { t } = useTranslation('archive');
  const navigate = useNavigate();
  const [items, setItems] = useState<ArchiveGameSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    archiveApi
      .getArchiveGamesMetadata({ sort: 'recent', limit: LIMIT })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refetchToken]);

  const handleRowClick = useCallback(
    (item: { id: string }) => navigate(`/archive/games/${item.id}`),
    [navigate],
  );

  return (
    <section
      className="archive-lobby__recent"
      data-testid="archive-lobby-recent"
    >
      <h2 className="archive-lobby__section-title">
        {t('lobby.recent.title', 'Recent games')}
      </h2>

      {loading && (items === null || items.length === 0) && (
        <div
          className="archive-games-list archive-games-list--loading"
          data-testid="archive-lobby-recent-skeleton"
        >
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="archive-games-list__skeleton-row" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div
          className="archive-games-list archive-games-list--error"
          data-testid="archive-lobby-recent-error"
        >
          <span>
            {t('lobby.recent.error', 'Failed to load recent games')}
          </span>
          <button
            type="button"
            className="archive-games-list__retry"
            data-testid="archive-lobby-recent-retry"
            onClick={() => setRefetchToken((n) => n + 1)}
          >
            {t('lobby.recent.retry', 'Retry')}
          </button>
        </div>
      )}

      {!loading && !error && items && items.length === 0 && (
        <p
          className="archive-games-list archive-games-list--empty"
          data-testid="archive-lobby-recent-empty"
        >
          {t('lobby.recent.empty', 'No games in the archive yet.')}
        </p>
      )}

      {!loading && !error && items && items.length > 0 && (
        <div
          className="archive-games-list"
          data-testid="archive-lobby-recent-list"
        >
          <div className="archive-games-list__rows">
            {items.map((item) => (
              <ArchiveGameRow
                key={item.id}
                item={item}
                onClick={handleRowClick}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
