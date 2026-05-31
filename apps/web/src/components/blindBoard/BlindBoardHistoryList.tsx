import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardHistoryItem,
  BlindBoardHistoryResponse,
} from '@kingside/shared';
import { api } from '../../api';
import { blindBoardApi } from '../../api/blindBoardApi';

/**
 * KS-3511 (ADR-093 §4.4) — список finished-сессий blind-board с
 * **cursor-пагинацией** (`GET /blind-board/history?cursor=&limit=20`).
 * В отличие от guess (offset+total), здесь backend отдаёт `nextCursor`
 * и `hasMore` — пишем cursor в state, по «Next» подставляем.
 */

const PAGE_SIZE = 20;

export interface BlindBoardHistoryListProps {
  fetcher?: (
    cursor: string | null,
    limit: number,
  ) => Promise<BlindBoardHistoryResponse>;
  /** KS-3530: DI для тестов — подмена blindBoardApi.deleteSession. */
  deleter?: (sessionId: string) => Promise<void>;
  /** KS-3530: DI confirm-диалога для тестов. */
  confirmFn?: (msg: string) => boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BlindBoardHistoryList({
  fetcher,
  deleter,
  confirmFn,
}: BlindBoardHistoryListProps = {}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<BlindBoardHistoryItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // cursorStack хранит cursor'ы для предыдущих страниц (back-навигация).
  // На первой странице cursorStack=[null]. После next пушим cursor
  // ОТВЕТА (тот, что использовали для текущей page), чтобы prev мог
  // восстановить.
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const currentCursor = cursorStack[cursorStack.length - 1];

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        ((c: string | null, l: number) => {
          const q = c ? `cursor=${encodeURIComponent(c)}&limit=${l}` : `limit=${l}`;
          return api.get<BlindBoardHistoryResponse>(
            `/blind-board/history?${q}`,
          );
        });
      const res = await get(currentCursor, PAGE_SIZE);
      setItems(res.items);
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch {
      setError(true);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [fetcher, currentCursor]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  // KS-3530: удаление сессии. confirm → DELETE → рефреш текущей
  // страницы. Cursor-пагинация переиспользует currentCursor — backend
  // отдаст актуальный snapshot без удалённой строки. Если удалили
  // последний item на page > 1 — откатываем на предыдущую страницу
  // через cursorStack.pop().
  const handleDelete = useCallback(
    async (sessionId: string) => {
      const confirm = confirmFn ?? ((m: string) => window.confirm(m));
      const ok = confirm(
        t(
          'blindBoard.history.confirmDelete',
          'Delete this session? This cannot be undone.',
        ),
      );
      if (!ok) return;
      setDeletingId(sessionId);
      try {
        const del =
          deleter ?? ((id: string) => blindBoardApi.deleteSession(id));
        await del(sessionId);
        const onlyOne = items.length === 1 && cursorStack.length > 1;
        if (onlyOne) {
          setCursorStack((s) => s.slice(0, -1));
        } else {
          void doFetch();
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[blind-board-history] delete failed', e);
      } finally {
        setDeletingId(null);
      }
    },
    [confirmFn, deleter, t, items.length, cursorStack.length, doFetch],
  );

  if (loading) {
    return (
      <section
        className="blind-board-history"
        data-testid="blind-board-history"
        data-state="loading"
      >
        <div
          className="blind-board-history__skeleton"
          data-testid="blind-board-history-skeleton"
        />
      </section>
    );
  }
  if (error) {
    return (
      <section
        className="blind-board-history"
        data-testid="blind-board-history"
        data-state="error"
      >
        <p>{t('blindBoard.history.error', 'Failed to load history')}</p>
        <button type="button" onClick={() => void doFetch()}>
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }
  if (items.length === 0 && cursorStack.length === 1) {
    return (
      <section
        className="blind-board-history"
        data-testid="blind-board-history"
        data-state="empty"
      >
        <p
          className="blind-board-history__placeholder"
          data-testid="blind-board-history-placeholder"
        >
          {t('blindBoard.history.empty', 'No finished sessions yet')}
        </p>
      </section>
    );
  }

  const canPrev = cursorStack.length > 1;
  const canNext = hasMore && nextCursor != null;

  return (
    <section
      className="blind-board-history"
      data-testid="blind-board-history"
      data-state="ready"
    >
      <ol className="blind-board-history__list">
        {items.map((s) => (
          <li
            key={s.id}
            className="blind-board-history__item"
            data-testid={`blind-board-history-item-${s.id}`}
            data-finish-reason={s.finishReason ?? ''}
          >
            {/* KS-3517: строка → review страница /blind-board/sessions/:id. */}
            <Link
              to={`/blind-board/sessions/${s.id}`}
              className="blind-board-history__link"
              data-testid={`blind-board-history-link-${s.id}`}
            >
              <span className="blind-board-history__date">
                {fmtDate(s.finishedAt)}
              </span>
              <span className="blind-board-history__level">L{s.level}</span>
              <span className="blind-board-history__streak">
                {t('blindBoard.history.streak', {
                  defaultValue: 'streak {{n}}',
                  n: s.bestStreak,
                })}
              </span>
              <span className="blind-board-history__reason">
                {s.finishReason
                  ? t(
                      `blindBoard.history.reason.${s.finishReason}`,
                      s.finishReason,
                    )
                  : '—'}
              </span>
            </Link>
            {/* KS-3530: иконка удаления — отдельная кнопка вне Link. */}
            <button
              type="button"
              className="blind-board-history__delete"
              data-testid={`blind-board-history-delete-${s.id}`}
              disabled={deletingId !== null}
              aria-busy={deletingId === s.id}
              aria-label={t('blindBoard.history.delete', 'Delete session')}
              title={t('blindBoard.history.delete', 'Delete session')}
              onClick={() => void handleDelete(s.id)}
            >
              🗑
            </button>
          </li>
        ))}
      </ol>
      <footer
        className="blind-board-history__pagination"
        data-testid="blind-board-history-pagination"
      >
        <button
          type="button"
          data-testid="blind-board-history-prev"
          disabled={!canPrev}
          onClick={() => setCursorStack((s) => s.slice(0, -1))}
        >
          {t('common.prev', 'Prev')}
        </button>
        <button
          type="button"
          data-testid="blind-board-history-next"
          disabled={!canNext}
          onClick={() => {
            if (nextCursor) setCursorStack((s) => [...s, nextCursor]);
          }}
        >
          {t('common.next', 'Next')}
        </button>
      </footer>
    </section>
  );
}
