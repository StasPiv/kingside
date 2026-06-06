import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type {
  LiveAnalysisCloseReason,
  LiveAnalysisOrientation,
  LiveAnalysisResponse,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useLiveAnalysisSocket } from '../hooks/useLiveAnalysisSocket';

/**
 * KS-3737 / ADR-110 §3, §6. Публичная страница зрителя живой
 * трансляции анализа партии.
 *
 * Жизненный цикл:
 *  1. На монт делаем `GET /live-analyses/:slug` — это primary source
 *     для первичной отрисовки доски ДО того как WS установит подписку
 *     (zero-flash при медленном соединении: рисуем сразу snapshot из
 *     REST, sync-event потом «догонит» с историей ходов).
 *  2. Подписываемся через `useLiveAnalysisSocket(slug)`. Без токена —
 *     анонимный viewer (ADR-110 §2.6). На каждый `connect` /
 *     reconnect хук сам шлёт `subscribe`, сервер возвращает
 *     `SyncSnapshot` (используем для апдейта authorFen).
 *  3. На `move`-event плавно применяем UCI к authorFen — анимация
 *     react-chessboard уже встроена в смену `position`.
 *  4. На `closed`-event замораживаем доску, показываем баннер с
 *     причиной (`by_owner` / `inactivity`).
 *
 * Локальная ветка зрителя: react-chessboard оставлен с
 * `allowDragging: true`, поэтому зритель может перетаскивать фигуры
 * и отыгрывать свои варианты. Любое перетаскивание сначала
 * валидируется через chess.js (нелегальный ход — drop отменяется),
 * затем меняется ТОЛЬКО локальный `viewerFen`. На сокет ничего не
 * улетает. Когда `viewerFen !== authorFen` — у нас активна локальная
 * ветка, показываем кнопку «Вернуться к трансляции», по клику
 * `viewerFen = authorFen`. Пока зритель в локальной ветке, новые
 * ходы автора обновляют только `authorFen`, не перерисовывая доску —
 * иначе мы перебили бы анализ зрителя посреди разбора.
 */

/** Префикс `<meta name="robots">` ставим только нашим. */
const ROBOTS_META_MARKER = 'data-kingside-live-analysis-robots';

function useNoIndexMeta(): void {
  // ADR-110 §6 / KS-3737 acceptance: страница зрителя не должна
  // индексироваться (контент эфемерный, slug одноразовый, ссылка
  // приватно делится автором — нет смысла светить её в SERP).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,nofollow';
    meta.setAttribute(ROBOTS_META_MARKER, 'true');
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

interface ViewerState {
  authorFen: string;
  authorPly: number;
  orientation: LiveAnalysisOrientation;
}

export function LiveAnalysisViewerPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  const { customPieces } = useBoardTheme();
  useNoIndexMeta();

  // ─── Loading / error state ────────────────────────────────────────
  const [snapshot, setSnapshot] = useState<LiveAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── Live state (обновляется через WS) ────────────────────────────
  const [view, setView] = useState<ViewerState | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [closedReason, setClosedReason] =
    useState<LiveAnalysisCloseReason | null>(null);

  // ─── Локальная ветка зрителя ──────────────────────────────────────
  // viewerFen хранит то, что реально показывается на доске. Может
  // отличаться от authorFen — это «локальная ветка». Кнопка
  // «Вернуться к трансляции» возвращает viewerFen на authorFen.
  const [viewerFen, setViewerFen] = useState<string | null>(null);
  const isOnLocalBranch = useMemo(() => {
    if (!view || !viewerFen) return false;
    return viewerFen !== view.authorFen;
  }, [view, viewerFen]);

  // ─── REST snapshot для первичной отрисовки ────────────────────────
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<LiveAnalysisResponse>(`/live-analyses/${slug}`)
      .then((resp) => {
        if (cancelled) return;
        setSnapshot(resp);
        setView({
          authorFen: resp.currentFen,
          authorPly: resp.currentPly,
          orientation: resp.orientation,
        });
        setViewerFen(resp.currentFen);
        setViewerCount(resp.viewerCount);
        if (resp.status === 'closed') {
          // Уже закрытая трансляция — REST вернул финальную позицию.
          // Считаем reason 'by_owner' по умолчанию (точный reason
          // приходит только в WS-`closed`-event; для cold-старта без
          // подписки на WS детализация не критична).
          setClosedReason('by_owner');
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setError('not-found');
        } else {
          const msg = e instanceof ApiError ? e.message : 'load-failed';
          setError(msg);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ─── WS подписка ──────────────────────────────────────────────────
  // useLiveAnalysisSocket сам поднимает соединение, шлёт subscribe на
  // каждый connect (включая reconnect), нам остаётся обработать
  // payload'ы.
  const handleSync = useCallback((payload: {
    slug: string;
    currentFen: string;
    currentPly: number;
    orientation: LiveAnalysisOrientation;
  }) => {
    setView((prev) => {
      const next: ViewerState = {
        authorFen: payload.currentFen,
        authorPly: payload.currentPly,
        orientation: payload.orientation,
      };
      // sync — это «авторитетный» snapshot. Если зритель НЕ в локальной
      // ветке, синхронизируем viewerFen тоже. Иначе оставляем зрителя
      // в его ветке — он сам нажмёт «Вернуться к трансляции», когда
      // захочет.
      setViewerFen((currentViewerFen) => {
        if (!prev || currentViewerFen === prev.authorFen) {
          return payload.currentFen;
        }
        return currentViewerFen;
      });
      return next;
    });
  }, []);

  const handleMove = useCallback(
    (payload: { slug: string; fen: string; ply: number; uci: string }) => {
      setView((prev) => {
        if (!prev) {
          // Move прилетел раньше sync (или REST snapshot) — редкий race;
          // принимаем как новую точку отсчёта.
          setViewerFen((curr) => (curr === null ? payload.fen : curr));
          return {
            authorFen: payload.fen,
            authorPly: payload.ply,
            orientation: 'white',
          };
        }
        // Защита от out-of-order: применяем только если ply строго
        // больше предыдущего. На случай дубля или старого move-event'а.
        if (payload.ply <= prev.authorPly) return prev;
        setViewerFen((currentViewerFen) => {
          // Если зритель НЕ в локальной ветке (его доска совпадала с
          // прошлой позицией автора) — синхронно подтягиваем новый ход.
          // Это даёт натуральную анимацию: react-chessboard анимирует
          // переход к новому `position`.
          if (currentViewerFen === prev.authorFen) {
            return payload.fen;
          }
          return currentViewerFen;
        });
        return { ...prev, authorFen: payload.fen, authorPly: payload.ply };
      });
    },
    [],
  );

  const handleViewers = useCallback((payload: { count: number }) => {
    setViewerCount(payload.count);
  }, []);

  const handleClosed = useCallback(
    (payload: { slug: string; reason: LiveAnalysisCloseReason }) => {
      setClosedReason(payload.reason);
    },
    [],
  );

  useLiveAnalysisSocket({
    slug: closedReason ? null : slug ?? null,
    onSync: handleSync,
    onMove: handleMove,
    onViewers: handleViewers,
    onClosed: handleClosed,
  });

  // ─── Локальное движение фигурой ───────────────────────────────────
  // chess.js валидирует ход на viewerFen. Если ход легален — обновляем
  // viewerFen на новый. Никаких WS-эмитов: трансляция и другие зрители
  // ничего не узнают.
  const localChessRef = useRef<InstanceType<typeof Chess>>(new Chess());
  const handlePieceDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!viewerFen) return false;
      if (!args.targetSquare) return false;
      const chess = localChessRef.current;
      try {
        chess.load(viewerFen);
        const move = chess.move({
          from: args.sourceSquare,
          to: args.targetSquare,
          // По умолчанию queen — для read-only UI выбор фигуры
          // превращения не нужен (это локальная песочница зрителя).
          promotion: 'q',
        });
        if (!move) return false;
        setViewerFen(chess.fen());
        return true;
      } catch {
        return false;
      }
    },
    [viewerFen],
  );

  const handleReturnToBroadcast = useCallback(() => {
    if (!view) return;
    setViewerFen(view.authorFen);
  }, [view]);

  // ─── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="loading" data-testid="live-analysis-viewer-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (error === 'not-found') {
    return (
      <div
        className="live-analysis-viewer live-analysis-viewer--not-found"
        data-testid="live-analysis-viewer-not-found"
      >
        <h1>{t('liveAnalysisViewer.notFoundTitle', 'Broadcast not found')}</h1>
        <p>
          {t(
            'liveAnalysisViewer.notFoundBody',
            'The broadcast link is invalid or the broadcast has been removed.',
          )}
        </p>
        <Link to="/" className="live-analysis-viewer__home-link">
          {t('common.backToHome', 'Back to home')}
        </Link>
      </div>
    );
  }

  if (error || !view || !snapshot) {
    return (
      <div
        className="live-analysis-viewer live-analysis-viewer--error"
        data-testid="live-analysis-viewer-error"
      >
        <p>{t('liveAnalysisViewer.loadError', 'Failed to load broadcast.')}</p>
      </div>
    );
  }

  return (
    <div
      className="live-analysis-viewer"
      data-testid="live-analysis-viewer"
    >
      <header className="live-analysis-viewer__header">
        <h1 className="live-analysis-viewer__title">
          {snapshot.title ||
            t('liveAnalysisViewer.defaultTitle', 'Live analysis')}
        </h1>
        {snapshot.ownerUsername && (
          <p className="live-analysis-viewer__owner">
            {t('liveAnalysisViewer.byOwner', 'by')}{' '}
            <Link to={`/player/${snapshot.ownerUsername}`}>
              {snapshot.ownerUsername}
            </Link>
          </p>
        )}
      </header>

      <div className="live-analysis-viewer__board-wrap">
        {/* Счётчик зрителей в углу. Скрываем при closed: финальный
            счётчик из последнего viewers-event-а сохраняется в стейте,
            но «X зрителей» как live-индикатор после конца теряет
            смысл — заменяется баннером «Трансляция завершена». */}
        {!closedReason && (
          <div
            className="live-analysis-viewer__viewers"
            data-testid="live-analysis-viewer-viewers"
            aria-label={t('liveAnalysisViewer.viewers', 'Viewers')}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              padding: '4px 10px',
              borderRadius: 12,
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              zIndex: 2,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#e53935',
                display: 'inline-block',
              }}
            />
            {viewerCount}{' '}
            {t('liveAnalysisViewer.viewersShort', 'viewers')}
          </div>
        )}

        <div
          className="live-analysis-viewer__board"
          style={{ position: 'relative' }}
        >
          <Chessboard
            options={{
              position: viewerFen ?? view.authorFen,
              boardOrientation: view.orientation,
              // Локальная ветка: зритель может двигать фигуры. Валидация
              // и обновление локального FEN — в handlePieceDrop, эмитов
              // в сокет нет.
              allowDragging: !closedReason,
              showNotation: true,
              animationDurationInMs: 200,
              onPieceDrop: handlePieceDrop,
              ...(customPieces && { pieces: customPieces }),
            }}
          />
        </div>

        {isOnLocalBranch && !closedReason && (
          <button
            type="button"
            className="live-analysis-viewer__return"
            data-testid="live-analysis-viewer-return"
            onClick={handleReturnToBroadcast}
          >
            {t(
              'liveAnalysisViewer.returnToBroadcast',
              'Return to broadcast',
            )}
          </button>
        )}
      </div>

      {closedReason && (
        <div
          className="live-analysis-viewer__closed-banner"
          data-testid="live-analysis-viewer-closed"
          role="status"
          aria-live="polite"
        >
          <strong>
            {t(
              'liveAnalysisViewer.closedTitle',
              'Broadcast ended',
            )}
          </strong>
          <p>
            {closedReason === 'by_owner'
              ? t(
                  'liveAnalysisViewer.closedByOwner',
                  'The author has ended the broadcast.',
                )
              : t(
                  'liveAnalysisViewer.closedByInactivity',
                  'The broadcast was closed due to inactivity.',
                )}
          </p>
        </div>
      )}
    </div>
  );
}
