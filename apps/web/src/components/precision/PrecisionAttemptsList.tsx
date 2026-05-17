import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import type {
  PrecisionAttemptListItem,
  PrecisionAttemptsListResponse,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';
// KS-3004 (ADR-065 §5.1.2, F3): compact 5-балльная оценка для строки
// каталога. Заменяет старую бинарную «УДЕРЖАНО/УПУЩЕНО» плашку.
import { PrecisionScoreBadge } from './PrecisionScoreBadge';
// KS-3075 → KS-3077: scorePct теперь приходит в list-DTO, используем
// единый источник «точности %» (synchronize со звёздами и detail-страницей).
import { pickDisplayedAccuracyPct } from '../../utils/precisionAccuracyDisplay';

/**
 * Диагностика причин ошибки загрузки. Используется и для console.error
 * (полная причина), и для UI (разные сообщения для разных проблем).
 */
type LoadErrorKind =
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'unauthorized' }
  | { kind: 'server'; status: number }
  | { kind: 'session-expired' }
  | { kind: 'unknown'; detail: string };

function classifyError(e: unknown): LoadErrorKind {
  if (e instanceof ApiError) {
    if (e.errorCode === 'NETWORK_ERROR') return { kind: 'network' };
    if (e.errorCode === 'REQUEST_TIMEOUT') return { kind: 'timeout' };
    if (e.status === 401 || e.status === 403) return { kind: 'unauthorized' };
    if (typeof e.status === 'number' && e.status >= 500) {
      return { kind: 'server', status: e.status };
    }
    return { kind: 'unknown', detail: `${e.status ?? '?'} ${e.errorCode ?? ''} ${e.message}`.trim() };
  }
  // request() в `api.ts` оборачивает провал refresh'а в `new Error('Session expired')`
  // (не-ApiError), отличаем по message.
  if (e instanceof Error && e.message === 'Session expired') {
    return { kind: 'session-expired' };
  }
  return { kind: 'unknown', detail: e instanceof Error ? e.message : String(e) };
}

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
  /**
   * KS-2745 follow-up: на `/precision/history` страница рендерит свой
   * `<h1>` («История попыток»), и внутренний `<h2>` списка с тем же
   * текстом превращается в дубль. Опциональный флаг прячет внутренний
   * заголовок без потери `data-state`-aware DOM (loading/error/empty
   * остаются на месте). По умолчанию `false` — там, где список
   * стоит сам по себе, заголовок остаётся.
   */
  hideTitle?: boolean;
}

export function PrecisionAttemptsList({
  fetcher,
  hideTitle = false,
}: PrecisionAttemptsListProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [items, setItems] = useState<PrecisionAttemptListItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  // Сохраняем причину, а не булеву — UI показывает разный текст,
  // консоль получает структурный лог (KS-3038/3039 hotfix scope:
  // координатор просил «залогируй причину или хотя бы разный текст»).
  const [error, setError] = useState<LoadErrorKind | null>(null);
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
        setError(null);
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
        setOffset(off + res.items.length);
      } catch (e) {
        const cause = classifyError(e);
        // KS-3038/3039 hotfix: до этого catch был пустой и UI всегда
        // показывал generic «Не удалось загрузить...». При диагностике
        // у пользователя это маскировало и сетевой error, и 401-refresh-fail,
        // и реальный 5xx. Логируем структурно — видно в DevTools/Sentry-like.
        // eslint-disable-next-line no-console
        console.error('[precision-attempts] load failed', {
          url,
          cause,
          raw: e,
        });
        setError(cause);
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

  const canLoadMore = items.length < total;

  // KS-3076: IntersectionObserver-based infinite scroll по образцу
  // /precision (KS-2769 коммит 9384df8a). Sentinel-div рендерится после
  // списка только когда `canLoadMore`. Observer переподписывается на
  // каждый mount sentinel'а (после смены фильтра или перерисовки).
  // rootMargin=600px — подгрузка чуть раньше чем sentinel реально въедет
  // в viewport.
  const sentinelInViewRef = useRef(false);
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (loadingMore || loading) return;
    if (!canLoadMore) return;
    void doFetch(offset, true);
  };
  const setSentinelEl = useCallback((el: HTMLDivElement | null) => {
    if (sentinelObserverRef.current) {
      sentinelObserverRef.current.disconnect();
      sentinelObserverRef.current = null;
    }
    if (!el) {
      sentinelInViewRef.current = false;
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        const isVis = entries[0]?.isIntersecting ?? false;
        sentinelInViewRef.current = isVis;
        if (isVis) loadMoreRef.current();
      },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    sentinelObserverRef.current = obs;
  }, []);
  useEffect(
    () => () => {
      sentinelObserverRef.current?.disconnect();
      sentinelObserverRef.current = null;
    },
    [],
  );
  // Fallback: если sentinel остался видимым после загрузки страницы
  // (грид короче экрана на большом мониторе — IntersectionObserver сам
  // не переотобьётся), повторно дёргаем loadMore.
  useEffect(() => {
    if (loading || loadingMore) return;
    if (!canLoadMore) return;
    if (sentinelInViewRef.current) {
      loadMoreRef.current();
    }
  }, [loading, loadingMore, canLoadMore, items.length]);

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
        {!hideTitle && (
          <h2 className="precision-attempts__title">
            {t('precisionAttempts.title', 'Attempt history')}
          </h2>
        )}
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
    const errorText =
      error.kind === 'network'
        ? t(
            'precisionAttempts.loadErrorNetwork',
            'No connection. Check your internet and try again.',
          )
        : error.kind === 'timeout'
          ? t(
              'precisionAttempts.loadErrorTimeout',
              'Server is not responding. Please retry.',
            )
          : error.kind === 'unauthorized' || error.kind === 'session-expired'
            ? t(
                'precisionAttempts.loadErrorSession',
                'Session expired. Sign in to see your attempts.',
              )
            : error.kind === 'server'
              ? t(
                  'precisionAttempts.loadErrorServer',
                  'Server error ({{status}}). Please retry.',
                  { status: error.status },
                )
              : t(
                  'precisionAttempts.loadError',
                  'Could not load attempt history.',
                );
    // Технический details — для скриншота при удалённой диагностике
    // (видно пользователю мелким шрифтом, помогает QA понять причину
    // без доступа к DevTools).
    const errorDetail =
      error.kind === 'unknown'
        ? error.detail
        : error.kind === 'server'
          ? `HTTP ${error.status}`
          : error.kind;
    return (
      <section
        className="precision-attempts"
        data-testid="precision-attempts"
        data-state="error"
        data-error-kind={error.kind}
      >
        {!hideTitle && (
          <h2 className="precision-attempts__title">
            {t('precisionAttempts.title', 'Attempt history')}
          </h2>
        )}
        <p className="precision-attempts__error">{errorText}</p>
        <p
          className="precision-attempts__error-detail"
          data-testid="precision-attempts-error-detail"
        >
          <code>{errorDetail}</code>
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
        {!hideTitle && (
          <h2 className="precision-attempts__title">
            {t('precisionAttempts.title', 'Attempt history')}
          </h2>
        )}
        <p
          className="precision-attempts__empty"
          data-testid="precision-attempts-empty"
        >
          {t('precisionAttempts.empty', "You don't have any attempts yet.")}
        </p>
      </section>
    );
  }

  return (
    <section
      className="precision-attempts"
      data-testid="precision-attempts"
      data-state="ready"
      data-total={String(total)}
      data-loaded={String(items.length)}
    >
      <header className="precision-attempts__header">
        {!hideTitle && (
          <h2 className="precision-attempts__title">
            {t('precisionAttempts.title', 'Attempt history')}
          </h2>
        )}
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
          // KS-3077: scorePct теперь приходит в list-DTO. Синхрон со
          // звёздами и detail-страницей через общую утилиту (KS-3075).
          const accuracyText = `${Math.round(pickDisplayedAccuracyPct(a))}%`;
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
                {/* KS-3076: превью-доска в стиле карточек /precision —
                    квадрат во всю ширину карточки, без notation (мелкая
                    нечитаемая на 64px она была), правильный orientation
                    из side-to-move в FEN. */}
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
                  {/* KS-3004 (ADR-065 §5.1.2, F3): compact 5-балльная
                      оценка вместо «УДЕРЖАНО/УПУЩЕНО». accuracy% остался
                      справа — complementary metrics §6.4 (а). */}
                  <PrecisionScoreBadge
                    score={a.score ?? null}
                    testIdSuffix={a.attemptId}
                  />
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

      {/* KS-3076: sentinel + IntersectionObserver вместо ручной кнопки
          «Load more» — единый паттерн с /precision (KS-2769). */}
      {canLoadMore && (
        <div
          ref={setSentinelEl}
          data-testid="precision-attempts-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}
      {loadingMore && (
        <p
          className="precision-attempts__loading-more"
          data-testid="precision-attempts-load-more"
        >
          {t('common.loading', 'Loading…')}
        </p>
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
