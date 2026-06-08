import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LiveAnalysisEvents,
  type LiveAnalysisAccessRevokedPayload,
  type LiveAnalysisCloseReason,
  type LiveAnalysisResponse,
  type LiveAnalysisSyncSnapshot,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useLiveAnalysisSocket } from '../hooks/useLiveAnalysisSocket';
import { useLectureToolsPolicy } from '../hooks/useLectureToolsPolicy';
import { deserializeLiveTree } from '../review/utils/liveTreeCodec';
import { liveAnalysisSocket } from '../socket';
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
  const navigate = useNavigate();
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
  // KS-3978 / ADR-119 D02. Состояние «доступ отозван» — тренер снял
  // зрителя из allowlist'а либо сменил visibility на restricted с
  // пустым списком. Событие `LiveAnalysisEvents.ACCESS_REVOKED`
  // приходит на already-подключённый сокет в namespace
  // `/live-analysis`. После получения показываем overlay 2 секунды,
  // затем редиректим пользователя на
  // `/lectures/:id/unavailable?reason=<revoked|visibility-changed>`.
  const [accessRevoked, setAccessRevoked] =
    useState<LiveAnalysisAccessRevokedPayload | null>(null);

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

  // KS-3906 / ADR-117 §3 (шаг C02). Политика «какие инструменты тренер
  // отключил ученикам» — для AnalysisPage в режиме зрителя живой
  // лекции. Начальное значение — из REST-snapshot (`snapshot
  // .lectureDisabledTools`, см. KS-3896 / `LiveAnalysisResponse`).
  // После подписки на WS события `LECTURE_TOOLS` хук сам подменяет
  // значение. До приезда snapshot-а и для трансляций без лекции
  // (`lectureDisabledTools === undefined`) хук возвращает пустой
  // массив — AnalysisPage показывает полный набор инструментов.
  // Пока snapshot не загружен / трансляция уже закрыта, slug в хуке
  // отключаем — иначе хук подпишется на чужую комнату или будет
  // держать listener в закрытой.
  const studentToolsPolicy = useLectureToolsPolicy(
    !snapshot || closedReason ? null : slug ?? null,
    snapshot?.lectureDisabledTools,
  );

  // KS-3978 / ADR-119 D02. Слушаем событие отзыва доступа на
  // `liveAnalysisSocket`. Используем глобальный socket напрямую,
  // потому что `useLiveAnalysisSocket` не пробрасывает кастомные
  // события (его API заточен под `sync/move/closed/viewers/error`).
  // Подписка активна, пока есть snapshot и доступ не закрыт по
  // другой причине; cleanup снимает listener при unmount или
  // смене slug. Гард по lectureId — `payload.lectureId` должен
  // совпадать с тем, что в snapshot'е; иначе это чужой room и
  // мы его игнорируем.
  useEffect(() => {
    if (!snapshot || closedReason || accessRevoked) return;
    // socket.io маршрутизирует события по комнатам, в которые мы
    // подписаны (subscribe { slug } делает `useLiveAnalysisSocket`).
    // Дополнительная фильтрация по lectureId здесь не нужна:
    // событие приходит в конкретную комнату текущей трансляции.
    // На всякий случай отсекаем пустые payload'ы.
    const handler = (payload: LiveAnalysisAccessRevokedPayload) => {
      if (!payload || typeof payload.lectureId !== 'string') return;
      setAccessRevoked(payload);
    };
    liveAnalysisSocket.on(LiveAnalysisEvents.ACCESS_REVOKED, handler);
    return () => {
      liveAnalysisSocket.off(LiveAnalysisEvents.ACCESS_REVOKED, handler);
    };
  }, [snapshot, closedReason, accessRevoked]);

  // Когда событие получено — показываем overlay две секунды и
  // отправляем пользователя на экран «недоступно». Reason берём
  // из payload (`revoked` / `visibility-changed`); если в URL нет
  // lectureId — fallback на slug-based редирект /lectures (общий
  // листинг). Эпик C на этой странице добавит ещё `ACCESS_DENIED`
  // в момент `subscribe`, обработка та же.
  useEffect(() => {
    if (!accessRevoked) return;
    const lectureId = accessRevoked.lectureId;
    const reason = encodeURIComponent(accessRevoked.reason);
    const timer = window.setTimeout(() => {
      if (lectureId) {
        navigate(
          `/lectures/${encodeURIComponent(lectureId)}/unavailable?reason=${reason}`,
          { replace: true },
        );
      } else {
        navigate(`/lectures?reason=${reason}`, { replace: true });
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [accessRevoked, navigate]);

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
      <AnalysisPage
        key={slug}
        liveSession={{ slug, mode: 'viewer' }}
        studentToolsPolicy={studentToolsPolicy}
      />

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

      {/* KS-3978 / ADR-119 D02. Overlay «Доступ отозван». Затемняет
          страницу и держится две секунды до того, как `useEffect`
          выше отправит пользователя на /lectures/:id/unavailable.
          Скрывает текущий контент, чтобы зритель не успел увидеть
          новые move'ы или sync'и, которые ещё могут прилететь до
          того, как backend закроет ему комнату. */}
      {accessRevoked && (
        <div
          className="live-analysis-viewer__access-revoked"
          data-testid="live-analysis-viewer-access-revoked"
          data-reason={accessRevoked.reason}
          role="alertdialog"
          aria-live="assertive"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            zIndex: 9999,
            padding: 24,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 24 }}>
            {t(
              'liveAnalysisViewer.accessRevokedTitle',
              'Access revoked',
            )}
          </h2>
          <p style={{ marginTop: 12, maxWidth: 420 }}>
            {accessRevoked.reason === 'visibility-changed'
              ? t(
                  'liveAnalysisViewer.accessRevokedVisibility',
                  'The author changed the lecture visibility. Redirecting…',
                )
              : t(
                  'liveAnalysisViewer.accessRevokedRevoked',
                  'The author removed your access to this lecture. Redirecting…',
                )}
          </p>
        </div>
      )}
    </div>
  );
}
