import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LiveAnalysisCloseReason,
  LiveAnalysisResponse,
  LiveAnalysisSyncSnapshot,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useLiveAnalysisSocket } from '../hooks/useLiveAnalysisSocket';
import { deserializeLiveTree } from '../review/utils/liveTreeCodec';
import { AnalysisPage } from './AnalysisPage';

/**
 * KS-3748 / ADR-111 §7. Тонкая обёртка над `AnalysisPage`,
 * включающая режим `liveSession={mode:'viewer'}`. Вся «толстая»
 * UI-механика (доска, дерево вариантов, Stockfish, AI, ArchiveTreePanel,
 * локальная ветка зрителя, кнопка «Вернуться к трансляции», применение
 * PGN из state-patch без сноса контекста — ADR-111 §2.8 п.5) теперь
 * живёт в `AnalysisPage` (через проп `liveSession`, см. KS-3747).
 * Виджет здесь занимается только тремя вещами:
 *
 *  1. Early-fetch `GET /live-analyses/:slug` — нужен чтобы:
 *     - проверить что трансляция вообще существует (404 → отдельная
 *       страница «not found», без подключения WS),
 *     - получить мета-инфо (title, ownerUsername) для header'а
 *       над AnalysisPage,
 *     - засечь cold-открытие уже закрытой трансляции (status=closed
 *       в REST до того как WS успеет прислать `closed`-event).
 *  2. WS-подписка через `useLiveAnalysisSocket` — нужна минимально,
 *     чтобы ловить `closed`-event и показывать баннер с reason.
 *     Снапшоты/move'ы AnalysisPage съест сам через хук
 *     `useLiveAnalysisBroadcast` внутри (KS-3746).
 *  3. `<meta name="robots" content="noindex,nofollow">` —
 *     эфемерный slug, ссылку приватно раздаёт автор, незачем светить
 *     в SERP.
 *
 * Прежний UI (своя доска, счётчик зрителей в углу, react-chessboard)
 * убран — он дублировал AnalysisPage и не имел доступа к PGN-дереву
 * автора. Счётчик зрителей теперь покажется внутри AnalysisPage в
 * статус-блоке live-трансляции (см. AnalysisPage owner-side
 * LiveBroadcastControl + viewer-side индикатор; на момент KS-3748
 * minimal — есть планы UI-улучшений в backlog).
 */

const ROBOTS_META_MARKER = 'data-kingside-live-analysis-robots';

function useNoIndexMeta(): void {
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

export function LiveAnalysisViewerPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  useNoIndexMeta();

  const [snapshot, setSnapshot] = useState<LiveAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not-found' | 'load-failed' | null>(null);
  const [closedReason, setClosedReason] =
    useState<LiveAnalysisCloseReason | null>(null);
  // KS-3780 follow-up: живой заголовок анализа. REST-снимок отдаёт
  // title только на момент создания трансляции, а автор может
  // переименовать анализ позже — без подписки на sync такая правка
  // у зрителя бы не отображалась.
  const [liveTitle, setLiveTitle] = useState<string | null>(null);

  // ─── Early-fetch (existence-check + meta) ─────────────────────────
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
        if (resp.status === 'closed') {
          // Cold-открытие уже закрытой трансляции. Точный reason
          // приходит только в WS-`closed`-event; здесь до подписки
          // считаем `by_owner` (более частый сценарий — автор сам
          // нажал «Завершить»).
          setClosedReason('by_owner');
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setError('not-found');
        } else {
          setError('load-failed');
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ─── WS-подписка только под `closed`-event ────────────────────────
  // AnalysisPage внутри подписывается сама через `useLiveAnalysisBroadcast`
  // и применяет sync/move/state-patch к review-state. Здесь же нам
  // нужен отдельный listener только чтобы показать баннер «Трансляция
  // завершена» с правильным reason — на AnalysisPage этот баннер
  // не выводится (она не знает, что её рисуют через `liveSession`).
  const handleClosed = useCallback(
    (payload: { reason: LiveAnalysisCloseReason }) => {
      setClosedReason(payload.reason);
    },
    [],
  );
  // KS-3780 follow-up: на каждый sync читаем `title` из дерева автора
  // и обновляем заголовок над AnalysisPage. AnalysisPage внутри
  // подписана сама и применяет дерево к review-state, мы же тут
  // используем сокет только ради заголовка и события closed.
  const handleSync = useCallback((payload: LiveAnalysisSyncSnapshot) => {
    if (typeof payload.tree !== 'string') return;
    try {
      const parsed = deserializeLiveTree(payload.tree);
      if (typeof parsed.title === 'string') {
        setLiveTitle(parsed.title);
      }
    } catch {
      /* неразборное дерево — заголовок просто не обновляем */
    }
  }, []);
  useLiveAnalysisSocket({
    // После closed подписка не нужна, иначе мы держим WS-комнату
    // ради уже закрытой трансляции.
    slug: !snapshot || closedReason ? null : slug ?? null,
    onClosed: handleClosed,
    onSync: handleSync,
  });

  // KS-3863: компактные значки лекции (запись для тренера и иконка
  // голоса для зрителя) рендерятся внутри `AnalysisPage` (рядом с
  // `LiveBroadcastBadge`), а не отдельным блоком на этой странице —
  // так шапка остаётся лаконичной, окно анализа само управляет
  // запуском записи через «Начать лекцию».

  // ─── Render: ранние ветки ─────────────────────────────────────────

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

  if (error || !snapshot || !slug) {
    return (
      <div
        className="live-analysis-viewer live-analysis-viewer--error"
        data-testid="live-analysis-viewer-error"
      >
        <p>{t('liveAnalysisViewer.loadError', 'Failed to load broadcast.')}</p>
      </div>
    );
  }

  // ─── Render: основная страница ────────────────────────────────────
  return (
    <div className="live-analysis-viewer" data-testid="live-analysis-viewer">
      <header className="live-analysis-viewer__header">
        <h1 className="live-analysis-viewer__title">
          {liveTitle ||
            snapshot.title ||
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

      {/* KS-3863: компактные значки лекции (запись для тренера,
          иконка голоса для зрителя) теперь живут в шапке самой
          AnalysisPage рядом с `LiveBroadcastBadge`. Отдельные большие
          блоки тут не нужны — окно анализа само ищет лекцию по slug-у
          и рендерит подходящий значок. */}

      {/* Сама «толстая» страница анализа в зрительском режиме.
          Внутри AnalysisPage:
            - useLiveAnalysisBroadcast(slug, 'viewer') ставит подписку;
            - sync/move/state-patch применяются к review-state с
              сохранением позиции зрителя (ADR-111 §2.8 п.5);
            - owner-only UI (autosave, Share, edit-title, Set Position,
              «Транслировать») подавлен гейтом publicMode || isViewerLive. */}
      {/* KS-3779: key={slug} принудительно пересоздаёт всё дерево
          AnalysisPage при смене slug — иначе при переходе зрителя с
          трансляции A на B в том же окне в Movelist оставалось дерево
          PGN от A (внутренний review-state не сбрасывался). */}
      <AnalysisPage key={slug} liveSession={{ slug, mode: 'viewer' }} />

      {closedReason && (
        <div
          className="live-analysis-viewer__closed-banner"
          data-testid="live-analysis-viewer-closed"
          role="status"
          aria-live="polite"
        >
          <strong>
            {t('liveAnalysisViewer.closedTitle', 'Broadcast ended')}
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
