import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LectureAudioInfo } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useAuth } from '../context/AuthContext';
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
  scheduledAt?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  // KS-3787 backend кладёт liveAnalysis в GET /lectures/:id для
  // active-lecture; для scheduled/cancelled поле null.
  liveAnalysis?: { id: string; slug: string; url: string } | null;
  /**
   * KS-3852 / ADR-116 §5.2. Если у лекции есть клиентская аудиозапись
   * (finalizer прошёл и в БД есть `LectureAudio`), backend кладёт
   * сюда signed CloudFront URL + длительность/codec. Если поле
   * `null`/отсутствует — лекция без записанного голоса, плеер
   * работает в старом timer-based режиме (без `<audio>` в DOM).
   */
  audio?: LectureAudioInfo | null;
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

  // KS-3852 / ADR-116 §5.2. Ref на скрытый `<audio>` для воспроизведения
  // записанного голоса тренера. Сам элемент рендерится ниже только если
  // у лекции есть `audio.url`.
  //
  // KS-3853, KS-3854 (audio-driven режим): когда есть аудио, аудиоэлемент
  // становится источником правды таймлайна (`currentT = audio.currentTime
  // * 1000 + offsetMs`), а доска применяет события до этого момента
  // через `replay.currentTimeMs` в `AnalysisPage`. Плеер (play/pause,
  // seek, скорость) управляет аудио, а не RAF-таймером.
  //
  // KS-3855 (graceful degradation): если у лекции `audio == null`,
  // плеер работает в старом timer-driven режиме (RAF + локальный
  // setCurrentTimeMs) и показывает info-значок «Запись звука
  // недоступна».
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  // KS-3853 / KS-3855. `audio-driven` если у лекции есть `audio.url`,
  // иначе `timer-driven`.
  const hasAudio = state.kind === 'ready' && Boolean(state.lecture.audio?.url);
  const audioOffsetMs =
    state.kind === 'ready' ? state.lecture.audio?.offsetMs ?? 0 : 0;

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

  // ─── audio-driven режим (KS-3853, KS-3854) ──────────────────────────
  // Подписка на события `<audio>`: play/pause синхронизируют isPlaying,
  // timeupdate обновляет currentTimeMs из `audio.currentTime`, ratechange
  // — speed. Дополнительно — RAF (см. ниже) даёт плавное обновление между
  // timeupdate-событиями (timeupdate приходит ~3–4 раза в секунду, для
  // визуально гладкого таймлайна нужно чаще).
  useEffect(() => {
    if (!hasAudio) return;
    const el = audioElementRef.current;
    if (!el) return;

    // KS-3854: применяем выставленную скорость + preservesPitch=true
    // при первом подключении audio, чтобы не было «бурундука» на ×1.5/×2.
    // `preservesPitch` доступен в современных браузерах; если нет — TS
    // не свалится (поле объявлено в lib.dom), но в рантайме мы не
    // упадём при присваивании.
    el.playbackRate = speed;
    try {
      el.preservesPitch = true;
    } catch {
      /* старые браузеры — игнорируем */
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => {
      setCurrentTimeMs(el.currentTime * 1000 + audioOffsetMs);
    };
    const handleRateChange = () => setSpeed(el.playbackRate);
    const handleEnded = () => setIsPlaying(false);

    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('timeupdate', handleTimeUpdate);
    el.addEventListener('ratechange', handleRateChange);
    el.addEventListener('ended', handleEnded);

    // Подтягиваем начальную позицию (если audio уже загрузился).
    setCurrentTimeMs(el.currentTime * 1000 + audioOffsetMs);

    return () => {
      el.removeEventListener('play', handlePlay);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('timeupdate', handleTimeUpdate);
      el.removeEventListener('ratechange', handleRateChange);
      el.removeEventListener('ended', handleEnded);
    };
  }, [hasAudio, audioOffsetMs, speed]);

  // KS-3853: плавное обновление currentTimeMs между timeupdate-событиями.
  // Эффект работает только пока audio играет — на паузе доска
  // автоматически замирает, так как currentTimeMs не меняется.
  useEffect(() => {
    if (!hasAudio || !isPlaying) return;
    const el = audioElementRef.current;
    if (!el) return;
    let raf: number | null = null;
    const tick = () => {
      // Если audio внезапно поставлен на паузу (например, браузер
      // приостановил из-за autoplay-policy), tick прекращается.
      if (el.paused) {
        raf = null;
        return;
      }
      setCurrentTimeMs(el.currentTime * 1000 + audioOffsetMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [hasAudio, isPlaying, audioOffsetMs]);

  // ─── timer-driven режим (KS-3855: оставляем как было) ───────────────
  // requestAnimationFrame-таймер — плавнее чем setInterval и не
  // переисполняется на вкладке в фоне. Активен только когда у лекции
  // нет аудио (`!hasAudio`).
  const rafRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (hasAudio) return; // в audio-driven режиме таймлайн ведёт <audio>
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
  }, [hasAudio, isPlaying, speed, durationMs]);

  const handlePlayPause = useCallback(() => {
    // KS-3853: в audio-driven режиме play/pause управляет <audio>;
    // isPlaying обновится через event-listener выше.
    if (hasAudio) {
      const el = audioElementRef.current;
      if (!el) return;
      if (el.paused) {
        // Если у конца записи — перематываем в начало (как timer-driven).
        if (el.duration > 0 && el.currentTime >= el.duration) {
          el.currentTime = 0;
        }
        el.play().catch(() => {
          /* autoplay-policy браузера — пользователь нажмёт ещё раз */
        });
      } else {
        el.pause();
      }
      return;
    }
    if (durationMs <= 0) return;
    setIsPlaying((p) => {
      if (!p && currentTimeMs >= durationMs) {
        // Если плеер у конца записи — клик «Play» возвращает в
        // начало и продолжает, иначе кнопка была бы no-op'ом.
        setCurrentTimeMs(0);
      }
      return !p;
    });
  }, [hasAudio, durationMs, currentTimeMs]);

  const handleSeek = useCallback(
    (nextMs: number) => {
      const clamped = Math.max(0, Math.min(durationMs, nextMs));
      // KS-3854: в audio-driven режиме seek = смена `audio.currentTime`;
      // доска перерисуется автоматически, так как `replay.currentTimeMs`
      // (производное от audio) поменяется и AnalysisPage применит
      // события до новой позиции (`event.t <= currentT`).
      if (hasAudio) {
        const el = audioElementRef.current;
        if (el) {
          // offsetMs может быть отрицательным (recorder стартовал до
          // первого recorded-event'а), поэтому клампим к [0, duration].
          const targetSec = Math.max(0, (clamped - audioOffsetMs) / 1000);
          el.currentTime = targetSec;
        }
        // Моментальный фидбек до timeupdate-события.
        setCurrentTimeMs(clamped);
        return;
      }
      setCurrentTimeMs(clamped);
    },
    [hasAudio, durationMs, audioOffsetMs],
  );

  const handleSetSpeed = useCallback(
    (s: number) => {
      setSpeed(s);
      // KS-3854: в audio-driven режиме реальную скорость задаёт
      // <audio>. preservesPitch=true сохраняет тембр голоса при ×1.5/×2.
      if (hasAudio) {
        const el = audioElementRef.current;
        if (el) {
          el.playbackRate = s;
          try {
            el.preservesPitch = true;
          } catch {
            /* старые браузеры — игнорируем */
          }
        }
      }
    },
    [hasAudio],
  );

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
    // KS-3804 / ADR-113 §4 крупная задача 3: ветка без записи —
    // дальше выбираем UI по lecture.status.
    return (
      <ScheduledOrCancelledOrLive
        lecture={state.lecture}
        onStarted={(updatedLecture) =>
          setState({ kind: 'no-recording', lecture: updatedLecture })
        }
      />
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

      {/* KS-3852: скрытый аудиоэлемент с записью голоса тренера. Если
          у лекции нет `audio.url` — не рендерим вовсе, плеер
          продолжает работать в старом timer-based режиме. preload
          "metadata" — Safari/Firefox начинают тянуть только заголовок,
          без целого файла; полная подгрузка — на первый play().
          `controls` нет: управление будет общим (KS-3854) через
          кнопку play/pause плеера ниже. */}
      {lecture.audio?.url && (
        <audio
          ref={audioElementRef}
          src={lecture.audio.url}
          preload="metadata"
          data-testid="lecture-replay-audio"
          style={{ display: 'none' }}
        />
      )}

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
            data-replay-mode={hasAudio ? 'audio-driven' : 'timer-driven'}
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
            {/* KS-3855 / ADR-116 §2.5. У лекции нет записанного голоса
                (finalizer не отработал, либо лекция велась без аудио) —
                плеер деградирует до старого timer-driven режима и
                сообщает об этом пользователю. */}
            {!hasAudio && (
              <div
                role="status"
                data-testid="lecture-replay-no-audio-badge"
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: '#e3f2fd',
                  border: '1px solid #90caf9',
                  color: '#0d47a1',
                  fontSize: 13,
                }}
              >
                {t(
                  'lectureReplay.noAudioBadge',
                  'Запись звука недоступна, плеер работает только по ходам.',
                )}
              </div>
            )}
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
                    onClick={() => handleSetSpeed(s)}
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

// ─────────────────────────────────────────────────────────────────────
// KS-3804: подкомпонент для scheduled/live/cancelled-веток. Вынесен
// чтобы держать в LectureReplayPage только плеер записи и не плодить
// у него лишних эффектов (отсчёт времени, POST /start, навигация в
// live-режим).
// ─────────────────────────────────────────────────────────────────────

interface ScheduledOrCancelledOrLiveProps {
  lecture: LectureSummary;
  onStarted: (updatedLecture: LectureSummary) => void;
}

interface StartLectureResponse {
  lecture: LectureSummary;
  liveAnalysis: { id: string; slug: string; url: string } | null;
}

function ScheduledOrCancelledOrLive({
  lecture,
  onStarted,
}: ScheduledOrCancelledOrLiveProps) {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const navigate = useNavigate();
  const isOwner =
    !!currentUser &&
    !!lecture.ownerUsername &&
    currentUser.username === lecture.ownerUsername;

  // KS-3804: live-лекция уже идёт — отправляем зрителя и автора на
  // публичный URL трансляции, чтобы не показывать заглушку «лекция
  // активна, но без ссылки».
  if (lecture.status === 'live' && lecture.liveAnalysis?.slug) {
    return <Navigate to={`/live/${lecture.liveAnalysis.slug}`} replace />;
  }

  // Тик каждую секунду — обновляет относительное «через X» / «должна
  // была начаться X минут назад». setInterval хватает: точность
  // секундная, не RAF-задачи.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (lecture.status !== 'scheduled') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lecture.status]);

  // POST /lectures/:id/start. Backend (KS-3784 follow-up b4a470c2)
  // принимает body { analysisId? }; без analysisId создаёт пустую
  // live-сессию через createBareLiveSession. Для запланированной
  // лекции analysisId у нас нет — поэтому отправляем пустое тело.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const resp = await api.post<StartLectureResponse>(
        `/lectures/${encodeURIComponent(lecture.id)}/start`,
        {},
      );
      if (resp.liveAnalysis?.slug) {
        // У автора и зрителя одинаковый итог — публичный URL
        // трансляции; redirect избавляет от рассинхрона состояний
        // (status='live', наличие liveAnalysis на странице лекции).
        navigate(`/live/${resp.liveAnalysis.slug}`);
        return;
      }
      // Defensive: ответ без liveAnalysis — обновляем lecture в
      // родителе и показываем то, что есть.
      onStarted(resp.lecture);
    } catch (e) {
      setStartError(
        e instanceof ApiError
          ? e.message
          : t(
              'lectureSchedule.start.failed',
              'Failed to start the lecture. Please try again.',
            ),
      );
    } finally {
      setStarting(false);
    }
  }, [lecture.id, navigate, onStarted, starting, t]);

  const renderOwnerLink = lecture.ownerUsername && (
    <p style={{ margin: '4px 0', fontSize: 13, opacity: 0.85 }}>
      {t('lectureReplay.byOwner', 'by')}{' '}
      <Link to={`/coach/${encodeURIComponent(lecture.ownerUsername)}`}>
        {lecture.ownerUsername}
      </Link>
    </p>
  );

  const absoluteTime = lecture.scheduledAt
    ? new Date(lecture.scheduledAt).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  // KS-3804: отсчёт по lecture.scheduledAt относительно now.
  let countdownLabel = '';
  let overdue = false;
  if (lecture.status === 'scheduled' && lecture.scheduledAt) {
    const target = new Date(lecture.scheduledAt).getTime();
    if (Number.isFinite(target)) {
      const diff = target - now;
      overdue = diff <= 0;
      const abs = Math.abs(diff);
      const sec = Math.floor(abs / 1000) % 60;
      const min = Math.floor(abs / (60 * 1000)) % 60;
      const hour = Math.floor(abs / (60 * 60 * 1000)) % 24;
      const day = Math.floor(abs / (24 * 60 * 60 * 1000));
      const parts: string[] = [];
      if (day > 0) parts.push(`${day}${t('coachProfile.durDay', 'd')}`);
      if (hour > 0) parts.push(`${hour}${t('coachProfile.durHour', 'h')}`);
      if (parts.length === 0) {
        parts.push(`${min}${t('coachProfile.durMin', 'm')}`);
        parts.push(`${sec.toString().padStart(2, '0')}${t('coachProfile.durSec', 's')}`);
      } else if (parts.length === 1 && day === 0) {
        parts.push(`${min}${t('coachProfile.durMin', 'm')}`);
      }
      countdownLabel = parts.join(' ');
    }
  }

  return (
    <div
      className="lecture-replay-page"
      data-testid="lecture-replay-page"
      style={{
        padding: 16,
        maxWidth: 640,
        margin: '0 auto',
      }}
    >
      <nav
        className="lecture-replay-breadcrumbs"
        aria-label={t('lectureReplay.breadcrumbsLabel', 'Lecture')}
        style={{
          margin: '4px 0 12px',
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
            >
              {lecture.ownerUsername}
            </Link>
            <span aria-hidden="true">/</span>
          </>
        )}
        <span style={{ fontWeight: 600 }}>{lecture.title}</span>
      </nav>

      {/* Контент по статусу: scheduled / cancelled / live-fallback. */}
      {lecture.status === 'scheduled' && (
        <div data-testid="lecture-scheduled-block">
          {lecture.description && (
            <p style={{ margin: '8px 0', opacity: 0.85 }}>
              {lecture.description}
            </p>
          )}
          {!isOwner && renderOwnerLink}
          {absoluteTime && (
            <p
              style={{ margin: '8px 0', fontSize: 14, opacity: 0.75 }}
              data-testid="lecture-scheduled-absolute"
            >
              {t('lectureSchedule.viewer.startsAt', 'Starts at')}{' '}
              {absoluteTime}
            </p>
          )}
          {countdownLabel && (
            <p
              style={{
                margin: '12px 0',
                fontSize: 28,
                fontWeight: 600,
              }}
              data-testid="lecture-scheduled-countdown"
            >
              {overdue
                ? t(
                    'lectureSchedule.viewer.overdue',
                    'Should have started {{value}} ago',
                    { value: countdownLabel },
                  )
                : t('lectureSchedule.viewer.startsIn', 'Starts in {{value}}', {
                    value: countdownLabel,
                  })}
            </p>
          )}

          {isOwner ? (
            <>
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={starting}
                data-testid="lecture-scheduled-start"
                style={{
                  marginTop: 16,
                  padding: '12px 24px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#1976d2',
                  color: '#fff',
                  fontSize: 18,
                  cursor: starting ? 'wait' : 'pointer',
                }}
              >
                {starting
                  ? t('common.loading', 'Loading…')
                  : t('lectureSchedule.start.button', 'Start lecture')}
              </button>
              {startError && (
                <p
                  className="error"
                  data-testid="lecture-scheduled-start-error"
                  style={{ marginTop: 8 }}
                >
                  {startError}
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled
              data-testid="lecture-scheduled-join"
              title={t(
                'lectureSchedule.viewer.joinDisabledTooltip',
                'The lecture has not started yet',
              )}
              style={{
                marginTop: 16,
                padding: '12px 24px',
                borderRadius: 8,
                border: '1px solid #ddd',
                background: '#f5f5f5',
                color: '#888',
                fontSize: 18,
                cursor: 'not-allowed',
              }}
            >
              {t('lectureSchedule.viewer.joinButton', 'Join')}
            </button>
          )}
        </div>
      )}

      {lecture.status === 'cancelled' && (
        <div data-testid="lecture-cancelled-block">
          {renderOwnerLink}
          <p style={{ margin: '12px 0', fontSize: 16 }}>
            {t(
              'lectureSchedule.cancelled.body',
              'This lecture has been cancelled.',
            )}
          </p>
        </div>
      )}

      {/* live без liveAnalysis.slug — крайне редкий случай (например,
          gap между «start выставил status=live» и «createBareLiveSession
          вернул slug»). Дам автору повторить попытку. */}
      {lecture.status === 'live' && !lecture.liveAnalysis?.slug && (
        <div data-testid="lecture-live-no-slug-block">
          {renderOwnerLink}
          <p style={{ margin: '12px 0' }}>
            {t(
              'lectureSchedule.live.noSlug',
              'The lecture is live but the broadcast link is not ready yet. Please refresh.',
            )}
          </p>
        </div>
      )}
    </div>
  );
}
