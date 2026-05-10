import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type {
  PrecisionAttemptListItem,
  PrecisionAttemptsListResponse,
} from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-2724 / ADR-056 §2.2. История precision-попыток текущего юзера.
 *
 * Источник — `GET /precision/attempts/me?limit=&offset=` (backend KS-2724,
 * api rev 161). Контракт `PrecisionAttemptsListResponse` из @kingside/shared.
 *
 * # Layout
 * Карточки в гриде, каждая карточка — одна попытка:
 *   [мини-доска (puzzleFen)] [результат + accuracy + classCounts] [кнопка «Разбор»]
 *
 * Клик по строке/кнопке → `navigate('/precision/attempts/:attemptId')`,
 * там уже работает `PrecisionAttemptPage` (KS-2719 F4).
 *
 * # Состояния
 *   - loading: skeleton (3 строки-плейсхолдера).
 *   - error: текст «Не удалось загрузить» + retry.
 *   - empty: «У тебя пока нет попыток».
 *   - ready: список + «Загрузить ещё» если items.length < total.
 *
 * Фильтр «Все / Удержано / Упущено» — клиентский, на уже загруженных
 * элементах. Для глобальной фильтрации (если total большой) пользователь
 * грузит больше через «Ещё».
 */

const PAGE_SIZE = 20;

type FilterTab = 'all' | 'preserved' | 'lost';

export interface PrecisionAttemptsListProps {
  /**
   * DI для тестов: подменяет вызов api.get. Production — undefined,
   * хук берёт `api.get` напрямую.
   */
  fetcher?: (
    url: string,
  ) => Promise<PrecisionAttemptsListResponse>;
}

export function PrecisionAttemptsList({ fetcher }: PrecisionAttemptsListProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [items, setItems] = useState<PrecisionAttemptListItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<boolean>(false);
  const [filter, setFilter] = useState<FilterTab>('all');

  const doFetch = useCallback(
    async (off: number, append: boolean) => {
      const url = `/precision/attempts/me?limit=${PAGE_SIZE}&offset=${off}`;
      const get =
        fetcher ?? ((u: string) => api.get<PrecisionAttemptsListResponse>(u));
      try {
        if (append) setLoadingMore(true);
        else setLoading(true);
        const res = await get(url);
        setError(false);
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
        setOffset(off + res.items.length);
      } catch {
        setError(true);
        if (!append) setItems([]);
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    void doFetch(0, false);
  }, [doFetch]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'preserved') return items.filter((a) => a.solved);
    return items.filter((a) => !a.solved);
  }, [items, filter]);

  const formatDate = (iso: string): string => {
    try {
      const d = new Date(iso);
      // Локализованное «дд.мм.гггг чч:мм».
      return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return iso;
    }
  };

  const sideFromFen = (fen: string): 'white' | 'black' => {
    const parts = fen.split(' ');
    return parts[1] === 'b' ? 'black' : 'white';
  };

  // Skeleton при первой загрузке.
  if (loading) {
    return (
      <section
        className="precision-attempts"
        data-testid="precision-attempts"
        data-state="loading"
      >
        <h2 className="precision-attempts__title">
          {t('precisionAttempts.title', 'Attempt history')}
        </h2>
        <ul className="precision-attempts__list">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="precision-attempts__row precision-attempts__row--skeleton"
              data-testid="precision-attempts-skeleton"
            />
          ))}
        </ul>
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="precision-attempts"
        data-testid="precision-attempts"
        data-state="error"
      >
        <h2 className="precision-attempts__title">
          {t('precisionAttempts.title', 'Attempt history')}
        </h2>
        <p className="precision-attempts__error">
          {t(
            'precisionAttempts.loadError',
            'Could not load attempt history.',
          )}
        </p>
        <button
          type="button"
          className="precision-attempts__retry"
          onClick={() => void doFetch(0, false)}
          data-testid="precision-attempts-retry"
        >
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section
        className="precision-attempts"
        data-testid="precision-attempts"
        data-state="empty"
      >
        <h2 className="precision-attempts__title">
          {t('precisionAttempts.title', 'Attempt history')}
        </h2>
        <p
          className="precision-attempts__empty"
          data-testid="precision-attempts-empty"
        >
          {t('precisionAttempts.empty', "You don't have any attempts yet.")}
        </p>
      </section>
    );
  }

  const canLoadMore = items.length < total;

  return (
    <section
      className="precision-attempts"
      data-testid="precision-attempts"
      data-state="ready"
      data-total={String(total)}
      data-loaded={String(items.length)}
    >
      <header className="precision-attempts__header">
        <h2 className="precision-attempts__title">
          {t('precisionAttempts.title', 'Attempt history')}
        </h2>
        <nav
          className="precision-attempts__filters"
          role="tablist"
          aria-label={t('precisionAttempts.filterLabel', 'Filter attempts')}
        >
          {(['all', 'preserved', 'lost'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={filter === tab}
              className={`precision-attempts__filter${filter === tab ? ' precision-attempts__filter--active' : ''}`}
              onClick={() => setFilter(tab)}
              data-testid={`precision-attempts-filter-${tab}`}
            >
              {tab === 'all'
                ? t('precisionAttempts.filter.all', 'All')
                : tab === 'preserved'
                  ? t('precisionAttempts.filter.preserved', 'Preserved')
                  : t('precisionAttempts.filter.lost', 'Lost')}
            </button>
          ))}
        </nav>
      </header>

      <ul className="precision-attempts__list">
        {filteredItems.map((a) => {
          const orientation = sideFromFen(a.puzzleFen);
          const verdict = a.solved
            ? t('precisionAttempts.result.preserved', 'Preserved')
            : t('precisionAttempts.result.lost', 'Lost');
          const accuracyText = `${Math.round(a.accuracyPercent)}%`;
          const onClick = () => navigate(`/precision/attempts/${a.attemptId}`);
          return (
            <li
              key={a.attemptId}
              className={`precision-attempts__row precision-attempts__row--${a.solved ? 'preserved' : 'lost'}`}
              data-testid={`precision-attempts-row-${a.attemptId}`}
              data-attempt-id={a.attemptId}
              data-solved={a.solved ? 'true' : 'false'}
            >
              <button
                type="button"
                className="precision-attempts__row-btn"
                onClick={onClick}
                data-testid={`precision-attempts-link-${a.attemptId}`}
                aria-label={t('precisionAttempts.openReview', 'Open review')}
              >
                <span className="precision-attempts__preview">
                  <Chessboard
                    options={{
                      position: a.puzzleFen,
                      boardOrientation: orientation,
                      animationDurationInMs: 0,
                      allowDragging: false,
                      showNotation: false,
                    }}
                  />
                </span>
                <span className="precision-attempts__main">
                  <span
                    className={`precision-attempts__verdict precision-attempts__verdict--${a.solved ? 'preserved' : 'lost'}`}
                  >
                    {verdict}
                  </span>
                  <span className="precision-attempts__accuracy">
                    {t('precisionAttempts.accuracy', 'Accuracy: {{value}}', {
                      value: accuracyText,
                    })}
                  </span>
                  <span className="precision-attempts__halfmoves">
                    {t('precisionAttempts.halfMoves', '{{count}} half-moves', {
                      count: a.halfMovesPlayed,
                    })}
                  </span>
                  <span
                    className="precision-attempts__badges"
                    data-testid={`precision-attempts-badges-${a.attemptId}`}
                  >
                    {(['best', 'good', 'inaccuracy', 'mistake', 'blunder'] as const)
                      .map((cls) => ({ cls, n: a.classCounts[cls] }))
                      .filter((x) => x.n > 0)
                      .map(({ cls, n }) => (
                        <span
                          key={cls}
                          className={`precision-attempts__badge precision-attempts__badge--${cls}`}
                          title={t(`precisionAttempt.classifications.${cls}`, cls)}
                          data-class={cls}
                        >
                          {n}
                        </span>
                      ))}
                  </span>
                  <span className="precision-attempts__date">
                    {formatDate(a.attemptedAt)}
                  </span>
                </span>
                <span className="precision-attempts__cta">
                  {t('precisionAttempts.review', 'Review')} →
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {canLoadMore && (
        <button
          type="button"
          className="precision-attempts__more"
          onClick={() => void doFetch(offset, true)}
          disabled={loadingMore}
          data-testid="precision-attempts-load-more"
        >
          {loadingMore
            ? t('common.loading', 'Loading…')
            : t('precisionAttempts.loadMore', 'Load more')}
        </button>
      )}

      {filteredItems.length === 0 && (
        <p
          className="precision-attempts__empty"
          data-testid="precision-attempts-filter-empty"
        >
          {t(
            'precisionAttempts.filterEmpty',
            'No attempts match this filter.',
          )}
        </p>
      )}
    </section>
  );
}
