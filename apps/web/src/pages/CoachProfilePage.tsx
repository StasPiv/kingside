import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PlayerProfileResponse } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useAuth } from '../context/AuthContext';
import { AuthorCoursesBlock } from '../components/lessons/AuthorCoursesBlock';
import { ScheduleLectureModal } from '../components/profile/ScheduleLectureModal';

/**
 * KS-3787 / ADR-113 §4 эпик 1. Публичная страница тренера.
 *
 * Маршрут: `/coach/:username`. Подключение: только пользователь, у
 * которого backend выставил `PlayerProfileResponse.isCoach = true`
 * (хотя бы один публичный курс или одна публичная лекция). Для всех
 * остальных делаем `Navigate → /player/:username` (по сценарию из
 * описания задачи — «редирект на /player/:username», менее
 * агрессивный вариант чем 404).
 *
 * Структура:
 *  - Header: имя, флаг страны (если задана), бейдж «Тренер».
 *  - Секция «Курсы» — переиспользуем `AuthorCoursesBlock` (тот же
 *    компонент, что и на странице обычного игрока, KS-1915). Блок
 *    сам скрывается, если у тренера нет публичных курсов.
 *  - Секция «В эфире» — `GET /coaches/:username/lectures?status=live`.
 *    Карточка содержит title/description/время старта и ссылку на
 *    `/live/<liveAnalysis.slug>` (KS-3784 backend кладёт liveAnalysis
 *    рядом с лекцией, чтобы не делать второй REST-запрос).
 *
 * Если `isCoach=false` или username не найден — редирект на
 * страницу обычного игрока. Cпециальной отдельной 404-страницы не
 * рисуем: пользователю удобнее видеть профиль игрока, чем «не
 * найдено».
 */

// Локальный тип лекции — пока shared-контракт не закрыт (KS-3787
// зависит от мини-доработки backend по форме ответа listByCoach).
// Поля совпадают с моделью Prisma, плюс вложенный liveAnalysis,
// добавляемый backend follow-up'ом под этот frontend.
type LectureStatus = 'scheduled' | 'live' | 'recorded' | 'cancelled';
interface LectureLiveSession {
  id: string;
  slug: string;
  url: string;
}
interface CoachLecture {
  id: string;
  title: string;
  description: string | null;
  status: LectureStatus;
  visibility: 'public' | 'unlisted';
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  liveAnalysisId: string | null;
  liveAnalysis: LectureLiveSession | null;
  // KS-3795: финализатор записи (эпик 2) проставляет ссылку на
  // готовый медиафайл. Поля могут быть пустыми, если запись ещё
  // обрабатывается или вообще не велась.
  recordingId: string | null;
  mediaUrl: string | null;
  mediaKind: string | null;
  createdAt: string;
  updatedAt: string;
}

function countryFlag(code: string | null | undefined): string | null {
  if (!code || code.length !== 2) return null;
  const A = 0x41;
  const REGIONAL = 0x1f1e6;
  const cc = code.toUpperCase();
  const c0 = cc.charCodeAt(0);
  const c1 = cc.charCodeAt(1);
  if (c0 < A || c0 > A + 25 || c1 < A || c1 > A + 25) return null;
  return (
    String.fromCodePoint(REGIONAL + (c0 - A)) +
    String.fromCodePoint(REGIONAL + (c1 - A))
  );
}

function formatStartedAt(value: string | null, locale: string): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/**
 * Длительность для карточки записи: «1ч 23м» / «12м» / «35с».
 * Берём `durationMs` если backend проставил (финализатор эпика 2),
 * иначе вычисляем из пары `startedAt`/`endedAt`. Если ни того, ни
 * другого — возвращаем пустую строку, потребитель скроет строчку.
 */
type TFn = (key: string, def?: string) => string;

function formatDuration(
  lecture: Pick<CoachLecture, 'durationMs' | 'startedAt' | 'endedAt'>,
  t: TFn,
): string {
  let ms: number | null = lecture.durationMs ?? null;
  if (ms === null && lecture.startedAt && lecture.endedAt) {
    try {
      const startMs = new Date(lecture.startedAt).getTime();
      const endMs = new Date(lecture.endedAt).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        ms = endMs - startMs;
      }
    } catch {
      ms = null;
    }
  }
  if (ms === null || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}${t('coachProfile.durHour', 'h')} ${minutes
      .toString()
      .padStart(2, '0')}${t('coachProfile.durMin', 'm')}`;
  }
  if (minutes > 0) {
    return `${minutes}${t('coachProfile.durMin', 'm')}`;
  }
  return `${seconds}${t('coachProfile.durSec', 's')}`;
}

export function CoachProfilePage() {
  const { t, i18n } = useTranslation();
  const { username } = useParams<{ username: string }>();
  const { user: currentUser } = useAuth();

  const [profile, setProfile] = useState<PlayerProfileResponse | null>(null);
  const [liveLectures, setLiveLectures] = useState<CoachLecture[]>([]);
  const [recordedLectures, setRecordedLectures] = useState<CoachLecture[]>([]);
  const [cancelledLectures, setCancelledLectures] = useState<CoachLecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // KS-3802 / ADR-113 §4 крупная задача 3: модальное окно
  // «Запланировать лекцию». Видимо только хозяину страницы; рендер
  // ниже под гейтом `isOwnPage`.
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleToast, setScheduleToast] = useState<string | null>(null);
  const handleScheduleCreated = useCallback(
    (lecture: { id: string; title: string; scheduledAt: string }) => {
      // Секцию «Расписание» нарисует KS-3803 — там же будет
      // рефреш списка scheduled-лекций. Сейчас минимально: показываем
      // мгновенное всплывающее уведомление, чтобы автор видел, что
      // запрос прошёл успешно.
      setScheduleToast(
        t('lectureSchedule.create.successToast', '«{{title}}» scheduled', {
          title: lecture.title,
        }),
      );
      window.setTimeout(() => setScheduleToast(null), 3500);
    },
    [t],
  );

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    // Профиль и три списка лекций тянем параллельно. Если профиль
    // 404 — показываем not-found без шанса для list-запроса перетереть
    // состояние. Ошибки списков не должны сорвать рендер профиля —
    // соответствующие секции в этом случае просто не отрисуются.
    const lecturesByStatus = (status: 'live' | 'recorded' | 'cancelled') =>
      api
        .get<CoachLecture[]>(
          `/coaches/${encodeURIComponent(username)}/lectures?status=${status}`,
        )
        .catch(() => [] as CoachLecture[]);
    Promise.all([
      api.get<PlayerProfileResponse>(
        `/players/${encodeURIComponent(username)}`,
      ),
      lecturesByStatus('live'),
      lecturesByStatus('recorded'),
      lecturesByStatus('cancelled'),
    ])
      .then(([p, live, recorded, cancelledList]) => {
        if (cancelled) return;
        setProfile(p);
        setLiveLectures(live);
        setRecordedLectures(recorded);
        setCancelledLectures(cancelledList);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError(
            t('coachProfile.loadError', 'Failed to load coach profile.'),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username, t]);

  if (loading) {
    return (
      <div className="coach-profile-page">
        <div className="loading">{t('common.loading', 'Loading...')}</div>
      </div>
    );
  }

  if (notFound) {
    // Username нет в players — редирект на /players (та же страница,
    // куда отправляет PlayerProfilePage в not-found ветке).
    return (
      <div className="coach-profile-page">
        <div className="player-profile-not-found">
          <h2>{t('playerProfile.notFound', 'Player not found')}</h2>
          <Link to="/players" className="players-link">
            {t('playerProfile.backToPlayers', 'Back to players')}
          </Link>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="coach-profile-page">
        <div className="error">
          {error || t('coachProfile.loadError', 'Failed to load coach profile.')}
        </div>
      </div>
    );
  }

  // Не-тренер: профиль найден, но isCoach=false. По ТЗ редиректим на
  // страницу обычного игрока, чтобы не путать пользователя 404-ой
  // когда сам пользователь существует.
  if (!profile.isCoach) {
    return (
      <Navigate
        to={`/player/${encodeURIComponent(profile.username)}`}
        replace
      />
    );
  }

  const flag = countryFlag(profile.country ?? null);
  // KS-3802: кнопка «Запланировать лекцию» доступна только хозяину
  // своей страницы. Сравнение по username (id у us тут нет с маршрута),
  // currentUser.username совпадает с params.username — это его страница.
  const isOwnPage =
    !!currentUser && currentUser.username === profile.username;

  return (
    <div className="coach-profile-page" data-testid="coach-profile-page">
      <Link to="/players" className="player-profile-back">
        {t('playerProfile.backToPlayers', 'Back to players')}
      </Link>

      {/* Header — упрощённый по сравнению с PlayerProfilePage, без
          блоков «друзья / сообщения / drill-статистика / рейтинг-
          история»: страница тренера — публичная витрина, эти разделы
          не относятся к преподавательской деятельности. */}
      <div className="player-profile-header">
        <div className="player-profile-avatar">
          {profile.username[0].toUpperCase()}
        </div>
        <div className="player-profile-info">
          <h1 className="player-profile-username">
            {flag && (
              <span
                className="player-profile-flag"
                title={profile.country ?? undefined}
                style={{ marginRight: 6 }}
              >
                {flag}
              </span>
            )}
            {profile.username}
            <span
              className="coach-profile-badge"
              data-testid="coach-profile-badge"
              style={{
                marginLeft: 12,
                padding: '2px 10px',
                borderRadius: 12,
                background: '#1976d2',
                color: '#fff',
                fontSize: 14,
                verticalAlign: 'middle',
              }}
            >
              {t('coachProfile.badge', 'Coach')}
            </span>
          </h1>
          <div
            className="player-profile-meta"
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {/* Ссылка на полноценный игровой профиль — на случай,
                если зритель пришёл искать партии тренера, а не
                образовательные материалы. */}
            <Link
              to={`/player/${encodeURIComponent(profile.username)}`}
              className="coach-profile-player-link"
              style={{ marginLeft: 0 }}
            >
              {t('coachProfile.openPlayerProfile', 'Open player profile')}
            </Link>
            {/* KS-3802: «Запланировать лекцию» — только на своей
                странице. По клику открывается ScheduleLectureModal с
                полями title/description/scheduledAt. */}
            {isOwnPage && (
              <button
                type="button"
                className="coach-profile-schedule-btn"
                data-testid="coach-profile-schedule-btn"
                onClick={() => setShowSchedule(true)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: '1px solid #1976d2',
                  background: '#1976d2',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {t('lectureSchedule.create.button', 'Schedule a lecture')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Toast «Лекция запланирована» — мгновенная обратная связь
          без перезагрузки страницы. Секцию «Расписание» с реальными
          scheduled-лекциями добавит KS-3803. */}
      {scheduleToast && (
        <div
          className="coach-profile-toast"
          data-testid="coach-profile-schedule-toast"
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 72,
            right: 16,
            background: '#1976d2',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            zIndex: 100,
            maxWidth: 320,
          }}
        >
          {scheduleToast}
        </div>
      )}

      {showSchedule && (
        <ScheduleLectureModal
          onClose={() => setShowSchedule(false)}
          onCreated={handleScheduleCreated}
        />
      )}

      {/* «В эфире» — карточки активных лекций. Скрываем секцию целиком,
          если активных нет — пустая секция «No live lectures» лишний шум
          для страницы, у которой могут быть только курсы. */}
      {liveLectures.length > 0 && (
        <section
          className="coach-profile-section"
          data-testid="coach-profile-live-section"
          aria-label={t('coachProfile.liveTitle', 'Live now')}
          style={{ marginTop: 24 }}
        >
          <h2>{t('coachProfile.liveTitle', 'Live now')}</h2>
          <ul
            className="coach-profile-live-grid"
            data-testid="coach-profile-live-grid"
            style={{
              listStyle: 'none',
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            {liveLectures.map((l) => {
              const slug = l.liveAnalysis?.slug;
              const startedLabel = formatStartedAt(l.startedAt, i18n.language);
              const card = (
                <>
                  <header style={{ marginBottom: 6 }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: '#d32f2f',
                        color: '#fff',
                        fontSize: 12,
                        marginRight: 8,
                      }}
                    >
                      {t('coachProfile.liveBadge', 'LIVE')}
                    </span>
                    <strong>{l.title}</strong>
                  </header>
                  {l.description && (
                    <p style={{ margin: '4px 0', fontSize: 14, opacity: 0.85 }}>
                      {l.description}
                    </p>
                  )}
                  {startedLabel && (
                    <footer style={{ fontSize: 12, opacity: 0.6 }}>
                      {t('coachProfile.startedAt', 'Started')}{' '}
                      {startedLabel}
                    </footer>
                  )}
                </>
              );
              return (
                <li
                  key={l.id}
                  className="coach-profile-live-card"
                  data-testid={`coach-profile-live-card-${l.id}`}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  {slug ? (
                    <Link
                      to={`/live/${slug}`}
                      style={{
                        textDecoration: 'none',
                        color: 'inherit',
                        display: 'block',
                      }}
                      data-testid={`coach-profile-live-link-${l.id}`}
                    >
                      {card}
                    </Link>
                  ) : (
                    // У live-лекции должен быть liveAnalysis (KS-3784
                    // backend кладёт ненулевой объект для статуса live);
                    // запасная ветка на случай рассинхронизации статуса
                    // и обнуления liveAnalysisId в момент закрытия —
                    // показываем карточку без ссылки.
                    card
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* KS-3795: «Записи» — recorded-лекции. После эпика 2 backend
          переводит статус в `recorded` финализатором и проставляет
          `recordingId`/`mediaUrl`. Карточка ведёт на /lectures/:id —
          там зритель смотрит запись (KS-3794, LectureReplayPage).
          Скрываем секцию, если recorded-записей нет. */}
      {recordedLectures.length > 0 && (
        <section
          className="coach-profile-section"
          data-testid="coach-profile-recordings-section"
          aria-label={t('coachProfile.recordingsTitle', 'Recordings')}
          style={{ marginTop: 24 }}
        >
          <h2>{t('coachProfile.recordingsTitle', 'Recordings')}</h2>
          <ul
            className="coach-profile-cards-grid"
            data-testid="coach-profile-recordings-grid"
            style={{
              listStyle: 'none',
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            {recordedLectures.map((l) => {
              const dateLabel = formatDate(l.endedAt, i18n.language);
              const duration = formatDuration(l, t as unknown as TFn);
              return (
                <li
                  key={l.id}
                  className="coach-profile-recording-card"
                  data-testid={`coach-profile-recording-card-${l.id}`}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <Link
                    to={`/lectures/${l.id}`}
                    style={{
                      textDecoration: 'none',
                      color: 'inherit',
                      display: 'block',
                    }}
                    data-testid={`coach-profile-recording-link-${l.id}`}
                  >
                    <header style={{ marginBottom: 6 }}>
                      <strong>{l.title}</strong>
                    </header>
                    {l.description && (
                      <p
                        style={{
                          margin: '4px 0',
                          fontSize: 14,
                          opacity: 0.85,
                        }}
                      >
                        {l.description}
                      </p>
                    )}
                    <footer
                      style={{
                        fontSize: 12,
                        opacity: 0.6,
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      {duration && (
                        <span>
                          {t('coachProfile.duration', 'Duration')}{' '}
                          {duration}
                        </span>
                      )}
                      {dateLabel && <span>{dateLabel}</span>}
                    </footer>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* KS-3795: «Завершённые без записи» — лекции в статусе
          `cancelled` (трансляция закончилась, но финализатор не
          сделал запись). Карточки информативные, без ссылки —
          смотреть нечего. */}
      {cancelledLectures.length > 0 && (
        <section
          className="coach-profile-section"
          data-testid="coach-profile-finished-section"
          aria-label={t('coachProfile.finishedTitle', 'Finished without recording')}
          style={{ marginTop: 24 }}
        >
          <h2>
            {t('coachProfile.finishedTitle', 'Finished without recording')}
          </h2>
          <ul
            className="coach-profile-cards-grid"
            data-testid="coach-profile-finished-grid"
            style={{
              listStyle: 'none',
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            {cancelledLectures.map((l) => {
              const dateLabel = formatDate(
                l.endedAt ?? l.scheduledAt,
                i18n.language,
              );
              const duration = formatDuration(l, t as unknown as TFn);
              return (
                <li
                  key={l.id}
                  className="coach-profile-finished-card"
                  data-testid={`coach-profile-finished-card-${l.id}`}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 8,
                    padding: 12,
                    opacity: 0.85,
                  }}
                >
                  <header style={{ marginBottom: 6 }}>
                    <strong>{l.title}</strong>
                  </header>
                  {l.description && (
                    <p style={{ margin: '4px 0', fontSize: 14, opacity: 0.85 }}>
                      {l.description}
                    </p>
                  )}
                  <footer
                    style={{
                      fontSize: 12,
                      opacity: 0.6,
                      display: 'flex',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    {duration && (
                      <span>
                        {t('coachProfile.duration', 'Duration')}{' '}
                        {duration}
                      </span>
                    )}
                    {dateLabel && <span>{dateLabel}</span>}
                    <span>
                      {t(
                        'coachProfile.noRecordingNote',
                        'no recording available',
                      )}
                    </span>
                  </footer>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* «Курсы» — переиспользуем существующий компонент. Он сам
          ходит за `/players/:username/courses` и тихо скрывается,
          если у автора нет публичных курсов. */}
      <section
        className="coach-profile-section"
        data-testid="coach-profile-courses-section"
        style={{ marginTop: 24 }}
      >
        <AuthorCoursesBlock username={profile.username} />
      </section>
    </div>
  );
}
