import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  LiveAnalysisCloseReason,
  LiveAnalysisResponse,
  LiveAnalysisSyncSnapshot,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useAuth } from '../context/AuthContext';
import { useLiveAnalysisSocket } from '../hooks/useLiveAnalysisSocket';
import { deserializeLiveTree } from '../review/utils/liveTreeCodec';
import { liveAnalysisSocket } from '../socket';
import { LecturePublisherControls } from '../components/lecture/LecturePublisherControls';
import { LectureAudioListener } from '../components/lecture/LectureAudioListener';
import { LectureRecordingBadge } from '../components/lecture/LectureRecordingBadge';
import { AnalysisPage } from './AnalysisPage';

/**
 * KS-3861. Облегчённый снимок лекции — то, что отдаёт
 * `GET /coaches/:username/lectures?status=live` (см. `CoachProfilePage`).
 * Здесь нам нужен только `id` и связка с `liveAnalysisId`, чтобы
 * найти ту лекцию, которая соответствует текущему slug-у трансляции.
 */
interface OwnerLectureLookup {
  id: string;
  liveAnalysisId: string | null;
  status: 'scheduled' | 'live' | 'recorded' | 'cancelled';
  startedAt: string | null;
}

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
  const { user: currentUser } = useAuth();
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

  // ─── KS-3861 / KS-3862: поиск лекции по live-analysis ─────────────
  //
  // Чтобы показать `LecturePublisherControls` владельцу (KS-3861) и
  // `LectureAudioListener` + `LectureRecordingBadge` зрителю (KS-3862),
  // нужен `lectureId`. Backend сейчас не отдаёт его в
  // `LiveAnalysisResponse` (см. `packages/shared/.../live-analysis.ts`),
  // поэтому используем listing `GET /coaches/:username/lectures?status=live`
  // и фильтруем по `liveAnalysisId === snapshot.id`. Listing публичный,
  // зритель тоже может его получить (как на странице тренера в
  // `CoachProfilePage`).
  const [ownerLecture, setOwnerLecture] = useState<OwnerLectureLookup | null>(
    null,
  );
  const isOwner = Boolean(
    currentUser &&
      snapshot?.ownerUsername &&
      currentUser.username === snapshot.ownerUsername,
  );
  useEffect(() => {
    setOwnerLecture(null);
    if (!snapshot || !snapshot.ownerUsername || closedReason) return;
    let cancelled = false;
    api
      .get<OwnerLectureLookup[]>(
        `/coaches/${encodeURIComponent(
          snapshot.ownerUsername,
        )}/lectures?status=live`,
      )
      .then((list) => {
        if (cancelled) return;
        const match =
          list.find((l) => l.liveAnalysisId === snapshot.id) ?? null;
        setOwnerLecture(match);
      })
      .catch(() => {
        // Не критично: если listing упал, блоки голоса/значка просто
        // не покажутся, остальной UI трансляции работает.
        if (!cancelled) setOwnerLecture(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot, closedReason]);

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
        <h1
          className="live-analysis-viewer__title"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          {liveTitle ||
            snapshot.title ||
            t('liveAnalysisViewer.defaultTitle', 'Live analysis')}
          {/* KS-3862: значок «🔴 Запись» появляется у зрителя, когда
              тренер на другой вкладке нажал «Включить микрофон». Сам
              тренер видит свой индикатор внутри LecturePublisherControls
              ниже, поэтому здесь значок не дублируем для владельца. */}
          {!isOwner && ownerLecture && !closedReason && (
            <LectureRecordingBadge
              lectureId={ownerLecture.id}
              socket={liveAnalysisSocket}
            />
          )}
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

      {/* KS-3861: блок управления записью голоса для автора лекции.
          Виден только владельцу live-analysis, к которому привязана
          активная лекция. Внутри использует `useLectureAudioPublisher`
          (запись + чанки) и `useLectureAudioPeerConnections` (WebRTC
          к зрителям) поверх того же `liveAnalysisSocket`, что и доска.
          clockSkewMs передаём 0: точный skew приходит только из
          ответа `POST /lectures/:id/start` (KS-3834), а на этой
          странице трансляция уже идёт — приближение «без коррекции»
          приемлемо, при первой синхронизации финализатор на бэке
          (KS-3846) пересчитает offset. */}
      {isOwner && ownerLecture && !closedReason && (
        <LecturePublisherControls
          lectureId={ownerLecture.id}
          socket={liveAnalysisSocket}
          recordingStartedAtClient={ownerLecture.startedAt}
          onClosed={() => navigate(`/lectures/${ownerLecture.id}`)}
        />
      )}

      {/* KS-3862: кнопка «🔊 Включить голос тренера» и регулятор
          громкости для зрителя. `<audio autoPlay muted playsInline>`
          ждёт первого user-gesture (см. autoplay-policy). После клика
          UI переходит в регулятор + значок «Голос в эфире». При
          переполнении peer-list (`webrtc:capacity-exceeded`,
          KS-3850) и при ICE-failure (KS-3849) внутри хука уже
          отображаются соответствующие значки. */}
      {!isOwner && ownerLecture && !closedReason && (
        <LectureAudioListener
          lectureId={ownerLecture.id}
          socket={liveAnalysisSocket}
        />
      )}

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
