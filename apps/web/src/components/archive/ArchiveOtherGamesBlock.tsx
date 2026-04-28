import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  ArchiveGamesByPositionItem,
  ArchiveGamesByPositionResponse,
} from '@kingside/shared';
import { ARCHIVE_URL } from '../../config/archiveUrl';
import { ArchiveGameRow } from './ArchiveGameRow';

/**
 * KS-2070 (F4 / ADR-033 §9.4): «Other games with this position».
 *
 * Свернутый по умолчанию блок на странице партии. Раскрывается по
 * клику — только тогда стучимся в archive-service за первой страницей
 * `games/by-position?fen=…&limit=5`. Это «lazy на текущем ply»: при
 * смене `positionFen` снаружи блок СБРАСЫВАЕТСЯ в свернутое состояние
 * (пользователь сам решает, нужны ли ему похожие партии для нового ply).
 *
 * Не используем `useArchiveGamesByPosition` — он построен под
 * страничку с infinite-scroll'ом и debounce'ом; здесь нужна одна
 * страница из 5 строк по явному клику.
 */

interface ArchiveOtherGamesBlockProps {
  /** FEN текущего ply на странице партии. */
  positionFen: string;
  /**
   * Id текущей открытой партии — исключаем её из списка похожих, чтобы
   * не показывать «эту же партию ещё раз». Опционально.
   */
  excludeGameId?: string;
  /** Колбэк клика по строке — навигация решается снаружи. */
  onSelectGame: (item: ArchiveGamesByPositionItem) => void;
}

const PAGE_SIZE = 5;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  return headers;
}

export function ArchiveOtherGamesBlock({
  positionFen,
  excludeGameId,
  onSelectGame,
}: ArchiveOtherGamesBlockProps) {
  const { t } = useTranslation('archive');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ArchiveGamesByPositionItem[] | null>(null);
  const [totalApprox, setTotalApprox] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // KS-2070: при смене ply снаружи (новый `positionFen`) сворачиваем
  // блок и сбрасываем загруженные данные. Следующий разворот
  // запросит свежие похожие партии для нового ply.
  useEffect(() => {
    setOpen(false);
    setItems(null);
    setTotalApprox(null);
    setError(null);
  }, [positionFen]);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        fen: positionFen,
        limit: String(PAGE_SIZE),
        sort: 'topElo',
      });
      const res = await fetch(
        `${ARCHIVE_URL}/games/by-position?${params.toString()}`,
        { method: 'GET', headers: authHeaders() },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as ArchiveGamesByPositionResponse;
      const filtered = excludeGameId
        ? data.items.filter((it) => it.id !== excludeGameId)
        : data.items;
      setItems(filtered);
      setTotalApprox(data.totalApprox ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [positionFen, excludeGameId]);

  const handleToggle = () => {
    if (open) {
      // Сворачиваем (но кэш `items` оставляем для следующего разворота
      // на ТОМ ЖЕ ply — `useEffect` сбросит его, если ply сменится).
      setOpen(false);
      return;
    }
    setOpen(true);
    if (items === null && !loading) {
      void fetchPage();
    }
  };

  return (
    <section
      className="archive-other-games"
      data-testid="archive-other-games"
      data-state={open ? 'open' : 'closed'}
    >
      <button
        type="button"
        className="archive-other-games__toggle"
        data-testid="archive-other-games-toggle"
        aria-expanded={open}
        onClick={handleToggle}
      >
        <span className="archive-other-games__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>
          {t('gamePage.otherGames.toggle', 'Other games with this position')}
        </span>
      </button>

      {open && (
        <div className="archive-other-games__body">
          {loading && (
            <p
              className="archive-other-games__loading"
              data-testid="archive-other-games-loading"
            >
              {t('gamePage.otherGames.loading', 'Loading…')}
            </p>
          )}

          {error && !loading && (
            <p
              className="archive-other-games__error"
              data-testid="archive-other-games-error"
            >
              {t(
                'gamePage.otherGames.error',
                'Could not load similar games. Try again.',
              )}
            </p>
          )}

          {items !== null && !loading && !error && items.length === 0 && (
            <p
              className="archive-other-games__empty"
              data-testid="archive-other-games-empty"
            >
              {t(
                'gamePage.otherGames.empty',
                'No other games found at this position.',
              )}
            </p>
          )}

          {items !== null && !loading && !error && items.length > 0 && (
            <>
              <ul className="archive-other-games__list">
                {items.map((item) => (
                  <li key={item.id}>
                    <ArchiveGameRow
                      item={item}
                      positionFen={positionFen}
                      onClick={onSelectGame}
                    />
                  </li>
                ))}
              </ul>
              <div className="archive-other-games__footer">
                <Link
                  to={`/archive/games?fen=${encodeURIComponent(positionFen)}`}
                  className="archive-other-games__see-all"
                  data-testid="archive-other-games-see-all"
                >
                  {t('gamePage.otherGames.seeAll', {
                    defaultValue: 'See all{{count}} →',
                    count: totalApprox ?? 0,
                    context: totalApprox && totalApprox > 0 ? 'count' : undefined,
                  })}
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
