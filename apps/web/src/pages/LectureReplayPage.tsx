import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ApiError } from '../ApiError';
import {
  AnalysisPage,
  type RecordedEvent,
  type ReplayLectureProps,
} from './AnalysisPage';

/**
 * KS-3794 / ADR-113 §4 крупная задача 2. Страница воспроизведения
 * записи лекции.
 *
 * Маршрут: `/lectures/:id`.
 *
 *   1. `GET /lectures/:id` — мета (title/description/ownerUsername),
 *      определяет статус и существование лекции.
 *   2. `GET /lectures/:id/recording` — события и стартовая мета
 *      записи (durationMs, startingFen, orientation, events[]).
 *      404 — у лекции нет записи (status != 'recorded' или
 *      finalizer ещё не отработал) — показываем сообщение.
 *
 * Управление воспроизведением живёт здесь:
 *   - play/pause через requestAnimationFrame-таймер;
 *   - seek через slider (range input) и клик по прогресс-полосе;
 *   - скорость ×1 / ×1.5 / ×2 как пресет-кнопки;
 *   - текущая позиция (`currentTimeMs`) контролируемо передаётся
 *     в AnalysisPage пропом `replay.currentTimeMs`. Внутри
 *     AnalysisPage на каждое изменение значения пересчитывается
 *     review-state через `applyReplayTree` (см. комментарии в
 *     AnalysisPage).
 *
 * Контроля состояния доски тут нет: AnalysisPage и replay-effect
 * сами знают как «перепрыгнуть» в произвольную точку записи.
 */

interface LectureSummary {
  id: string;
  title: string;
  description: string | null;
  status: 'scheduled' | 'live' | 'recorded' | 'cancelled';
  ownerUsername?: string;
  startedAt: string | null;
  endedAt: string | null;
}

interface LectureRecording {
  id: string;
  lectureId: string;
  events: RecordedEvent[];
  durationMs: number;
  eventCount: number;
  byteSize: number;
  startingFen: string | null;
  orientation: 'white' | 'black';
  truncated: boolean;
  createdAt: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'no-recording'; lecture: LectureSummary }
  | { kind: 'load-failed' }
  | { kind: 'ready'; lecture: LectureSummary; recording: LectureRecording };

const SPEEDS: ReadonlyArray<number> = [1, 1.5, 2];

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function LectureReplayPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  // ─── Загрузка лекции и записи ──────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([
      api.get<LectureSummary>(`/lectures/${encodeURIComponent(id)}`),
      api
        .get<LectureRecording>(
          `/lectures/${encodeURIComponent(id)}/recording`,
        )
        .then((r) => ({ ok: true as const, recording: r }))
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) {
            return { ok: false as const };
          }
          throw e;
        }),
    ])
      .then(([lecture, recordingResult]) => {
        if (cancelled) return;
        if (!recordingResult.ok) {
          setState({ kind: 'no-recording', lecture });
          return;
        }
        setState({
          kind: 'ready',
          lecture,
          recording: recordingResult.recording,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setState({ kind: 'not-found' });
        } else {
          setState({ kind: 'load-failed' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ─── Плеер: state и таймер ─────────────────────────────────────────
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(1);

  // При смене лекции — сбрасываем плеер. Иначе позиция из старой
  // лекции «протечёт» в новую и обновим dial в неконсистентное
  // значение до первого тика.
  useEffect(() => {
    setCurrentTimeMs(0);
    setIsPlaying(false);
    setSpeed(1);
  }, [id]);

  const durationMs =
    state.kind === 'ready' ? state.recording.durationMs : 0;

  // requestAnimationFrame-таймер — плавнее чем setInterval и не
  // переисполняется на вкладке в фоне.
  const rafRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickAtRef.current = null;
      return;
    }
    const tick = (now: number) => {
      const last = lastTickAtRef.current ?? now;
      const deltaReal = now - last;
      lastTickAtRef.current = now;
      // Шкала «времени записи» идёт быстрее реального времени в
      // `speed` раз.
      setCurrentTimeMs((prev) => {
        const next = prev + deltaReal * speed;
        if (durationMs > 0 && next >= durationMs) {
          setIsPlaying(false);
          return durationMs;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickAtRef.current = null;
    };
  }, [isPlaying, speed, durationMs]);

  const handlePlayPause = useCallback(() => {
    if (durationMs <= 0) return;
    setIsPlaying((p) => {
      if (!p && currentTimeMs >= durationMs) {
        // Если плеер у конца записи — клик «Play» возвращает в
        // начало и продолжает, иначе кнопка была бы no-op'ом.
        setCurrentTimeMs(0);
      }
      return !p;
    });
  }, [durationMs, currentTimeMs]);

  const handleSeek = useCallback((nextMs: number) => {
    setCurrentTimeMs(Math.max(0, Math.min(durationMs, nextMs)));
  }, [durationMs]);

  // KS-3798 (повторно): первая попытка с sticky-плеером + динамическим
  // padding-bottom не сработала — плеер позиционировался относительно
  // `.main` (overflow:hidden), а AnalysisPage внутри забирает всю
  // высоту через flex:1 независимо от padding обёртки. Перешёл на
  // flex-колоночный layout (см. JSX ниже): плеер — обычный flex-ребёнок
  // c flex-shrink:0, AnalysisPage — flex:1; min-height:0. Доска
  // пересчитывается сама.

  // ─── replay-проп для AnalysisPage ──────────────────────────────────
  const replay: ReplayLectureProps | null = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return {
      lectureId: state.lecture.id,
      events: state.recording.events,
      durationMs: state.recording.durationMs,
      startingFen: state.recording.startingFen,
      orientation: state.recording.orientation,
      currentTimeMs,
    };
  }, [state, currentTimeMs]);

  // ─── Render ────────────────────────────────────────────────────────

  if (state.kind === 'loading') {
    return (
      <div className="lecture-replay-page">
        <div className="loading">{t('common.loading', 'Loading...')}</div>
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div className="lecture-replay-page">
        <h1>{t('lectureReplay.notFoundTitle', 'Lecture not found')}</h1>
        <p>
          {t(
            'lectureReplay.notFoundBody',
            'The lecture link is invalid or the lecture has been removed.',
          )}
        </p>
        <Link to="/players">
          {t('playerProfile.backToPlayers', 'Back to players')}
        </Link>
      </div>
    );
  }

  if (state.kind === 'load-failed') {
    return (
      <div className="lecture-replay-page">
        <p>
          {t('lectureReplay.loadError', 'Failed to load the lecture.')}
        </p>
      </div>
    );
  }

  if (state.kind === 'no-recording') {
    return (
      <div className="lecture-replay-page">
        <header className="lecture-replay-header">
          <h1>{state.lecture.title}</h1>
          {state.lecture.ownerUsername && (
            <p>
              {t('lectureReplay.byOwner', 'by')}{' '}
              <Link
                to={`/coach/${encodeURIComponent(state.lecture.ownerUsername)}`}
              >
                {state.lecture.ownerUsername}
              </Link>
            </p>
          )}
        </header>
        <p>
          {t(
            'lectureReplay.noRecordingBody',
            'This lecture has no recording yet. Please come back later.',
          )}
        </p>
      </div>
    );
  }

  // state.kind === 'ready'
  const { lecture, recording } = state;
  const eventsEmpty = recording.events.length === 0;

  return (
    <div
      className="lecture-replay-page"
      data-testid="lecture-replay-page"
      // KS-3798 (повторно): AnalysisPage снаружи `body.has-analysis-page
      // .main` (см. layout.css §«Game/Analysis») — это flex-колонка с
      // overflow:hidden, и `.analysis-page` тянет flex:1. Если оставить
      // плеер sticky-блоком, он позиционируется относительно scrolling
      // ancestor (`.main`), а AnalysisPage ВСЕГДА забирает всю высоту
      // `.main` независимо от padding-bottom родителя — поэтому
      // навигация под доской уходит за плеер. Решение — `.lecture-replay-
      // page` сам flex-колонка: nav (auto) → AnalysisPage-wrapper
      // (flex:1, min-height:0) → плеер (auto, обычный блок). Доска
      // внутри AnalysisPage пересчитает свой размер от уменьшенной
      // высоты родителя и навигация всегда поместится над плеером.
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* KS-3797: убрали большой `h1` и отдельную строку «by …» —
          они занимали вертикаль, из-за чего доска обрезалась снизу
          на десктопе и плеер уходил под нижнее меню на мобильном.
          Название и автор теперь живут в компактной строке-крошках
          одной строкой над AnalysisPage. */}
      <nav
        className="lecture-replay-breadcrumbs"
        data-testid="lecture-replay-breadcrumbs"
        aria-label={t('lectureReplay.breadcrumbsLabel', 'Lecture')}
        style={{
          margin: '4px 0 8px',
          fontSize: 13,
          opacity: 0.85,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {lecture.ownerUsername && (
          <>
            <Link
              to={`/coach/${encodeURIComponent(lecture.ownerUsername)}`}
              data-testid="lecture-replay-owner-link"
            >
              {lecture.ownerUsername}
            </Link>
            <span aria-hidden="true">/</span>
          </>
        )}
        <span
          data-testid="lecture-replay-title"
          title={lecture.description ?? undefined}
          style={{ fontWeight: 600 }}
        >
          {lecture.title}
        </span>
        {recording.truncated && (
          <span
            data-testid="lecture-replay-truncated-note"
            style={{ marginLeft: 8, color: '#b26a00', fontSize: 12 }}
          >
            {t(
              'lectureReplay.truncatedNote',
              'Recording was truncated — only the first part is available.',
            )}
          </span>
        )}
      </nav>

      {eventsEmpty ? (
        <p data-testid="lecture-replay-empty">
          {t('lectureReplay.emptyBody', 'No content was recorded.')}
        </p>
      ) : (
        <>
          {/* Сама «толстая» страница анализа в режиме replay.
              Внутри AnalysisPage на каждое изменение currentTimeMs
              пересчитывается review-state через applyReplayTree.
              KS-3798: обёртка — flex-ребёнок с flex:1; min-height:0.
              Так AnalysisPage получает оставшуюся после плеера высоту,
              а доска внутри пересчитает свой размер от реального
              видимого пространства, не выезжая под плеер. */}
          <div
            data-testid="lecture-replay-analysis-wrapper"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {replay && <AnalysisPage replay={replay} />}
          </div>

          {/* Плеер: progress + play/pause + скорость. Обычный блок,
              flex-shrink:0 — занимает свою высоту в нижней части
              `.lecture-replay-page`. Sticky/fixed убраны: они
              позиционировались относительно `.main` (overflow:hidden)
              и перекрывали навигацию под доской AnalysisPage. */}
          <div
            className="lecture-replay-player"
            data-testid="lecture-replay-player"
            style={{
              background: '#fff',
              borderTop: '1px solid #ddd',
              // KS-3797: учитываем системные безопасные отступы
              // (iOS home-indicator, Android nav-bar), чтобы плеер
              // не уходил под нижнюю системную панель.
              padding:
                '12px 16px calc(12px + env(safe-area-inset-bottom)) 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <input
              type="range"
              min={0}
              max={durationMs}
              step={1}
              value={Math.min(currentTimeMs, durationMs)}
              onChange={(e) => handleSeek(Number(e.target.value))}
              data-testid="lecture-replay-progress"
              style={{ width: '100%' }}
              aria-label={t(
                'lectureReplay.progressLabel',
                'Playback position',
              )}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={handlePlayPause}
                data-testid="lecture-replay-play"
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: '1px solid #1976d2',
                  background: '#1976d2',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {isPlaying
                  ? t('lectureReplay.pause', 'Pause')
                  : t('lectureReplay.play', 'Play')}
              </button>
              <span
                style={{ fontFamily: 'monospace', minWidth: 90 }}
                data-testid="lecture-replay-time"
              >
                {formatTime(currentTimeMs)} / {formatTime(durationMs)}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSpeed(s)}
                    data-testid={`lecture-replay-speed-${s}`}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid #ddd',
                      background: speed === s ? '#1976d2' : '#fff',
                      color: speed === s ? '#fff' : 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    ×{s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
