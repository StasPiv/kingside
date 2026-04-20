import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveBucket,
  ArchiveGameColor,
  ArchiveGameDetail,
  ArchiveGameResult,
  ArchiveGamesByPositionItem,
  ArchiveGamesSort,
} from '@kingside/shared';
import { ArchivePositionHeader } from '../components/archive/ArchivePositionHeader';
import {
  ArchiveGamesFilters,
  type ArchiveGamesFilterValues,
  type ColorFilterValue,
  type ResultFilterValue,
  type SinceFilterValue,
} from '../components/archive/ArchiveGamesFilters';
import { ArchiveGamesList } from '../components/archive/ArchiveGamesList';
import { useArchiveGamesByPosition, type UseArchiveGamesByPositionFilters } from '../hooks/useArchiveGamesByPosition';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001') as string;
const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const VALID_SORTS: readonly ArchiveGamesSort[] = ['recent', 'topElo'];
const VALID_RESULTS: readonly ResultFilterValue[] = ['any', '1-0', '0-1', '1/2-1/2'];
const VALID_COLORS: readonly ColorFilterValue[] = ['any', 'white', 'black'];
const VALID_SINCES: readonly SinceFilterValue[] = ['all', '1y', '5y'];
const VALID_BUCKETS: readonly ArchiveBucket[] = ['master', 'user'];

function parseSort(raw: string | null): ArchiveGamesSort {
  return VALID_SORTS.includes(raw as ArchiveGamesSort) ? (raw as ArchiveGamesSort) : 'recent';
}

function parseResult(raw: string | null): ResultFilterValue {
  return VALID_RESULTS.includes(raw as ResultFilterValue) ? (raw as ResultFilterValue) : 'any';
}

function parseColor(raw: string | null): ColorFilterValue {
  return VALID_COLORS.includes(raw as ColorFilterValue) ? (raw as ColorFilterValue) : 'any';
}

function parseSince(raw: string | null): SinceFilterValue {
  return VALID_SINCES.includes(raw as SinceFilterValue) ? (raw as SinceFilterValue) : 'all';
}

function parseBucket(raw: string | null): ArchiveBucket | undefined {
  return VALID_BUCKETS.includes(raw as ArchiveBucket) ? (raw as ArchiveBucket) : undefined;
}

function parseMinElo(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sinceToIsoDate(since: SinceFilterValue): string | undefined {
  if (since === 'all') return undefined;
  const now = new Date();
  if (since === '1y') now.setFullYear(now.getFullYear() - 1);
  if (since === '5y') now.setFullYear(now.getFullYear() - 5);
  return now.toISOString().slice(0, 10);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  return headers;
}

/**
 * /archive/games — list of archived games that reached a given position.
 *
 * Query-params (read/write via useSearchParams):
 *   fen, bucket, sort, result, minElo, since, color, player, eco, move
 *
 * ADR-014 §6.
 */
export function ArchiveGamesByPositionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const fen = searchParams.get('fen') ?? '';
  const bucket = parseBucket(searchParams.get('bucket'));
  const sort = parseSort(searchParams.get('sort'));
  const result = parseResult(searchParams.get('result'));
  const minElo = parseMinElo(searchParams.get('minElo'));
  const since = parseSince(searchParams.get('since'));
  const color = parseColor(searchParams.get('color'));
  const player = searchParams.get('player') ?? '';
  const eco = searchParams.get('eco') ?? '';
  const move = searchParams.get('move') ?? '';

  const filterValues: ArchiveGamesFilterValues = useMemo(
    () => ({ sort, result, minElo, since, color, player, eco }),
    [sort, result, minElo, since, color, player, eco],
  );

  const hasActiveFilters =
    result !== 'any' ||
    minElo !== null ||
    since !== 'all' ||
    color !== 'any' ||
    player !== '' ||
    eco !== '' ||
    move !== '';

  // Translate filter values into backend-facing filters.
  const hookFilters: UseArchiveGamesByPositionFilters = useMemo(
    () => ({
      bucket,
      sort,
      minElo: minElo ?? undefined,
      since: sinceToIsoDate(since),
      result: result === 'any' ? undefined : (result as ArchiveGameResult),
      color: color === 'any' ? undefined : (color as ArchiveGameColor),
      move: move || undefined,
      player: player || undefined,
      eco: eco || undefined,
    }),
    [bucket, sort, minElo, since, result, color, move, player, eco],
  );

  const {
    items,
    hasMore,
    totalApprox,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refetch,
  } = useArchiveGamesByPosition(fen, hookFilters);

  const setFromFilters = useCallback(
    (next: ArchiveGamesFilterValues) => {
      // Reset cursor by re-issuing the URL without a cursor (the hook
      // keys on fen + filters, so any change triggers a fresh first page).
      const params = new URLSearchParams(searchParams);
      if (fen) params.set('fen', fen);
      if (bucket) params.set('bucket', bucket); else params.delete('bucket');
      params.set('sort', next.sort);
      if (next.result !== 'any') params.set('result', next.result); else params.delete('result');
      if (next.minElo !== null) params.set('minElo', String(next.minElo)); else params.delete('minElo');
      if (next.since !== 'all') params.set('since', next.since); else params.delete('since');
      if (next.color !== 'any') params.set('color', next.color); else params.delete('color');
      if (next.player) params.set('player', next.player); else params.delete('player');
      if (next.eco) params.set('eco', next.eco); else params.delete('eco');
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams, fen, bucket],
  );

  const resetFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (fen) params.set('fen', fen);
    if (bucket) params.set('bucket', bucket);
    params.set('sort', 'recent');
    setSearchParams(params, { replace: true });
  }, [fen, bucket, setSearchParams]);

  const handleRowClick = useCallback(
    async (item: ArchiveGamesByPositionItem) => {
      // Fetch PGN for the selected archived game and hand it to /analysis
      // via router state — mirrors the pattern used in WorkshopPgnList.
      try {
        const res = await fetch(`${API_URL}/api/archive/games/${item.id}`, {
          method: 'GET',
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = (await res.json()) as ArchiveGameDetail;
        const whiteLabel = detail.white.name ?? '—';
        const blackLabel = detail.black.name ?? '—';
        navigate('/analysis', {
          state: {
            pgn: detail.pgn,
            title: `${whiteLabel} vs ${blackLabel}`,
            breadcrumbSection: t('archive.games.breadcrumb', 'Archive games'),
            breadcrumbBackUrl: `/archive/games?${searchParams.toString()}`,
          },
        });
      } catch {
        // Surface a lightweight error via a re-render of the list (no state here
        // to avoid a brittle dependency). User can click again; real UX polish
        // (toast / inline banner) happens in the styling task (KS-1614).
        refetch();
      }
    },
    [navigate, t, searchParams, refetch],
  );

  if (!fen) {
    return (
      <div className="archive-games-page archive-games-page--missing-fen" data-testid="archive-games-page">
        <p>{t('archive.games.missingFen', 'No position specified. Open this page from the analysis board.')}</p>
      </div>
    );
  }

  return (
    <div className="archive-games-page" data-testid="archive-games-page">
      <ArchivePositionHeader fen={fen || DEFAULT_FEN} totalApprox={totalApprox} />

      <ArchiveGamesFilters values={filterValues} onChange={setFromFilters} />

      <ArchiveGamesList
        items={items}
        positionFen={fen}
        isLoading={isLoading}
        isLoadingMore={isLoadingMore}
        hasMore={hasMore}
        error={error}
        hasActiveFilters={hasActiveFilters}
        onLoadMore={loadMore}
        onRetry={refetch}
        onResetFilters={resetFilters}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
