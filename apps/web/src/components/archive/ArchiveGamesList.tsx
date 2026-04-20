import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArchiveGamesByPositionItem } from '@kingside/shared';
import { ArchiveGameRow } from './ArchiveGameRow';

interface ArchiveGamesListProps {
  items: ArchiveGamesByPositionItem[];
  positionFen: string;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  hasActiveFilters: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onResetFilters?: () => void;
  onRowClick: (item: ArchiveGamesByPositionItem) => void;
}

const SKELETON_ROWS = 6;

/**
 * Games-by-position list with:
 * - first-page loading skeleton
 * - error state + retry
 * - empty state (with "reset filters" CTA when filters are active)
 * - infinite scroll via IntersectionObserver on a sentinel, plus a
 *   manual "Load more" button as a fallback.
 */
export function ArchiveGamesList({
  items,
  positionFen,
  isLoading,
  isLoadingMore,
  hasMore,
  error,
  hasActiveFilters,
  onLoadMore,
  onRetry,
  onResetFilters,
  onRowClick,
}: ArchiveGamesListProps) {
  const { t } = useTranslation();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore) return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onLoadMoreRef.current();
          }
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, items.length]);

  // First-page loading skeleton
  if (isLoading && items.length === 0) {
    return (
      <div className="archive-games-list archive-games-list--loading" data-testid="archive-games-skeleton">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="archive-games-list__skeleton-row" />
        ))}
      </div>
    );
  }

  // Error on first page
  if (error && items.length === 0) {
    return (
      <div className="archive-games-list archive-games-list--error" data-testid="archive-games-error">
        <span>{t('archive.games.errorMessage', 'Failed to load games')}</span>
        <button type="button" onClick={onRetry} className="archive-games-list__retry">
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  // Empty state
  if (!isLoading && items.length === 0) {
    return (
      <div className="archive-games-list archive-games-list--empty" data-testid="archive-games-empty">
        <p>{t('archive.games.empty', 'No games found in this position')}</p>
        {hasActiveFilters && onResetFilters && (
          <button
            type="button"
            className="archive-games-list__reset-filters"
            onClick={onResetFilters}
          >
            {t('archive.games.resetFilters', 'Reset filters')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="archive-games-list" data-testid="archive-games-list">
      <div className="archive-games-list__rows">
        {items.map((item) => (
          <ArchiveGameRow
            key={item.id}
            item={item}
            positionFen={positionFen}
            onClick={onRowClick}
          />
        ))}
      </div>

      {/* Inline non-blocking error when paginating */}
      {error && items.length > 0 && (
        <div className="archive-games-list__inline-error" data-testid="archive-games-inline-error">
          <span>{t('archive.games.errorMessage', 'Failed to load games')}</span>
          <button type="button" onClick={onRetry} className="archive-games-list__retry">
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {hasMore && (
        <>
          <div ref={sentinelRef} className="archive-games-list__sentinel" aria-hidden="true" />
          <button
            type="button"
            className="archive-games-list__load-more"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            data-testid="archive-games-load-more"
          >
            {isLoadingMore
              ? t('archive.games.loadingMore', 'Loading…')
              : t('archive.games.loadMore', 'Load more')}
          </button>
        </>
      )}
    </div>
  );
}
