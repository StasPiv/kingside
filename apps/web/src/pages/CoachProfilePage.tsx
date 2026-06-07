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

/**
 * KS-3803: относительное время до scheduledAt: «через 3 часа»,
 * «через 5 минут», «уже идёт». Использует `Intl.RelativeTimeFormat`
 * (поддерживается во всех современных браузерах). На случай старых
 * браузеров без него — возвращает пустую строку, потребитель в
 * крайнем случае покажет только абсолютную дату.
 */
function formatRelativeToNow(iso: string, locale: string): string {
  try {
    const target = new Date(iso).getTime();
    if (!Number.isFinite(target)) return '';
    const diffMs = target - Date.now();
    if (typeof Intl.RelativeTimeFormat !== 'function') return '';
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(diffMs);
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    const week = 7 * day;
    if (abs >= week) {
      const value = Math.round(diffMs / day);
      return rtf.format(value, 'day');
    }
    if (abs >= day) {
      const value = Math.round(diffMs / day);
      return rtf.format(value, 'day');
    }
    if (abs >= hour) {
      const value = Math.round(diffMs / hour);
      return rtf.format(value, 'hour');
    }
    const value = Math.round(diffMs / min);
    return rtf.format(value, 'minute');
  } catch {
    return '';
  }
}

export function CoachProfilePage() {
  const { t, i18n } = useTranslation();
  const { username } = useParams<{ username: string }>();
  const { user: currentUser } = useAuth();

  const [profile, setProfile] = useState<PlayerProfileResponse | null>(null);
  const [liveLectures, setLiveLectures] = useState<CoachLecture[]>([]);
  const [scheduledLectures, setScheduledLectures] = useState<CoachLecture[]>([]);
  const [recordedLectures, setRecordedLectures] = useState<CoachLecture[]>([]);
  const [cancelledLectures, setCancelledLectures] = useState<CoachLecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // KS-3863 follow-up: id лекции, которую сейчас закрываем кнопкой
  // «Завершить лекцию» в карточке live-секции. Нужно, чтобы пометить
  // конкретную карточку как «в процессе» и не дать кликнуть дважды.
  const [endingLectureId, setEndingLectureId] = useState<string | null>(null);
  // KS-3802/KS-3803: модальное окно «Запланировать / Изменить
  // лекцию». editingLecture !== null → режим редактирования.
  const [showSchedule, setShowSchedule] = useState(false);
  const [editingLecture, setEditingLecture] = useState<{
    id: string;
    title: string;
    description?: string | null;
    scheduledAt: string;
  } | null>(null);
  const [scheduleToast, setScheduleToast] = useState<string | null>(null);
  const showToast = useCallback((message: string) => {
    setScheduleToast(message);
    window.setTimeout(() => setScheduleToast(null), 3500);
  }, []);
  const handleScheduleCreated = useCallback(
    (lecture: { id: string; title: string; scheduledAt: string }) => {
      // KS-3803: обновляем секцию «Расписание» оптимистично — без
      // лишнего GET-запроса. Сортировка по scheduledAt ASC: вставляем
      // новую лекцию в правильное место.
      setScheduledLectures((prev) => {
        const next = [...prev, lecture as CoachLecture];
        next.sort((a, b) => {
          const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
          const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
          return ta - tb;
        });
        return next;
      });
      showToast(
        t('lectureSchedule.create.successToast', '«{{title}}» scheduled', {
          title: lecture.title,
        }),
      );
    },
    [showToast, t],
  );
  const handleLectureEdited = useCallback(
    (lecture: { id: string; title: string; scheduledAt: string }) => {
      // KS-3803: обновляем карточку в state. Сортируем заново — у
      // лекции могло поменяться scheduledAt.
      setScheduledLectures((prev) => {
        const next = prev.map((l) =>
          l.id === lecture.id ? { ...l, ...lecture } : l,
        );
        next.sort((a, b) => {
          const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
          const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
          return ta - tb;
        });
        return next;
      });
      showToast(
        t('lectureSchedule.edit.successToast', '«{{title}}» updated', {
          title: lecture.title,
        }),
      );
    },
    [showToast, t],
  );
  const handleCancelLecture = useCallback(
    async (lecture: CoachLecture) => {
      // KS-3800 / KS-3803: POST /lectures/:id/cancel — owner-only.
      // Confirm: спрашиваем подтверждение, чтобы не отменить случайно.
      if (
        !window.confirm(
          t(
            'lectureSchedule.cancel.confirm',
            'Cancel «{{title}}»? This cannot be undone.',
            { title: lecture.title },
          ),
        )
      ) {
        return;
      }
      try {
        await api.post(
          `/lectures/${encodeURIComponent(lecture.id)}/cancel`,
          {},
        );
        // Оптимистично выкидываем из расписания.
        setScheduledLectures((prev) => prev.filter((l) => l.id !== lecture.id));
        showToast(
          t('lectureSchedule.cancel.successToast', '«{{title}}» cancelled', {
            title: lecture.title,
          }),
        );
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : t(
                'lectureSchedule.cancel.failed',
                'Failed to cancel the lecture. Please try again.',
              );
        showToast(msg);
      }
    },
    [showToast, t],
  );

  // KS-3867: общая обработка ошибок owner-only API запросов
  // (force-end и delete). 401 пускаем дальше — глобальный
  // notifySessionExpired в api.ts уведомит AuthContext и сделает
  // редирект на /login. 403/409/5xx — короткий тост по описанию
  // задачи.
  const handleLectureApiError = useCallback(
    (e: unknown, action: 'force-end' | 'delete') => {
      if (e instanceof ApiError) {
        // 401 уже обработан в api.ts (dispatch session-expired);
        // тост показывать не нужно — будет редирект.
        if (e.status === 401) return;
        if (e.status === 403) {
          showToast(t('lectureLive.noPermission', 'Нет прав на это действие'));
          return;
        }
        if (e.status === 409) {
          showToast(
            t(
              'lectureLive.invalidStatus',
              'Действие недоступно для текущего статуса лекции',
            ),
          );
          return;
        }
        if (e.status >= 500) {
          showToast(
            t(
              'lectureLive.serverError',
              'Не удалось выполнить, попробуйте позже',
            ),
          );
          return;
        }
      }
      // Прочие случаи (сеть, неизвестная ошибка) — общий fallback.
      showToast(
        action === 'force-end'
          ? t(
              'lectureLive.endFailed',
              'Не удалось завершить лекцию. Попробуйте ещё раз.',
            )
          : t(
              'lectureLive.deleteFailed',
              'Не удалось удалить лекцию. Попробуйте ещё раз.',
            ),
      );
    },
    [showToast, t],
  );

  // KS-3867: принудительное завершение live-лекции из карточки на
  // странице тренера. Нужно, когда тренер закрыл вкладку без
  // финализации — лекция «зависла» в статусе live, и зрители
  // продолжают видеть её как идущую. Маршрут /force-end (KS-3864)
  // финализирует аудио best-effort и переводит статус в recorded.
  const handleEndLecture = useCallback(
    async (lecture: CoachLecture) => {
      if (endingLectureId) return;
      if (
        !window.confirm(
          t(
            'lectureLive.endConfirm',
            'Завершить лекцию «{{title}}»?',
            { title: lecture.title },
          ),
        )
      ) {
        return;
      }
      setEndingLectureId(lecture.id);
      try {
        await api.post(
          `/lectures/${encodeURIComponent(lecture.id)}/force-end`,
          {},
        );
        // Оптимистично переносим карточку из «В эфире» в
        // «Записанные» — серверный статус теперь recorded. Сама
        // карточка сохраняет title/description, но мы выставляем
        // endedAt = текущее время, чтобы сортировка/подпись в
        // «Записанных» работали корректно до следующей загрузки.
        const nowIso = new Date().toISOString();
        setLiveLectures((prev) => prev.filter((l) => l.id !== lecture.id));
        setRecordedLectures((prev) => [
          { ...lecture, status: 'recorded', endedAt: nowIso },
          ...prev,
        ]);
        showToast(
          t(
            'lectureLive.endSuccessToast',
            'Лекция «{{title}}» завершена',
            { title: lecture.title },
          ),
        );
      } catch (e) {
        handleLectureApiError(e, 'force-end');
      } finally {
        setEndingLectureId(null);
      }
    },
    [endingLectureId, handleLectureApiError, showToast, t],
  );

  // KS-3867: удаление лекции. Запрещено для статуса live (бэкенд
  // вернёт 409). Кнопка для live и не показывается — но на всякий
  // случай дублируем guard в обработчике.
  const [deletingLectureId, setDeletingLectureId] = useState<string | null>(
    null,
  );
  const handleDeleteLecture = useCallback(
    async (lecture: CoachLecture) => {
      if (deletingLectureId) return;
      if (lecture.status === 'live') return;
      if (
        !window.confirm(
          t(
            'lectureDelete.confirm',
            'Удалить лекцию «{{title}}»? Действие необратимо.',
            { title: lecture.title },
          ),
        )
      ) {
        return;
      }
      setDeletingLectureId(lecture.id);
      try {
        await api.delete<void>(`/lectures/${encodeURIComponent(lecture.id)}`);
        // Карточка живёт ровно в одном из четырёх списков по статусу.
        // Удаляем из всех, чтобы не зависеть от того, в каком она
        // сейчас (например, лекция могла дрейфовать между статусами).
        const filterOut = (prev: CoachLecture[]) =>
          prev.filter((l) => l.id !== lecture.id);
        setScheduledLectures(filterOut);
        setRecordedLectures(filterOut);
        setCancelledLectures(filterOut);
        showToast(
          t(
            'lectureDelete.successToast',
            'Лекция «{{title}}» удалена',
            { title: lecture.title },
          ),
        );
      } catch (e) {
        handleLectureApiError(e, 'delete');
      } finally {
        setDeletingLectureId(null);
      }
    },
    [deletingLectureId, handleLectureApiError, showToast, t],
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
    const lecturesByStatus = (
      status: 'live' | 'scheduled' | 'recorded' | 'cancelled',
    ) =>
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
      lecturesByStatus('scheduled'),
      lecturesByStatus('recorded'),
      lecturesByStatus('cancelled'),
    ])
      .then(([p, live, scheduled, recorded, cancelledList]) => {
        if (cancelled) return;
        setProfile(p);
        setLiveLectures(live);
        setScheduledLectures(scheduled);
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
          onSaved={handleScheduleCreated}
        />
      )}
      {editingLecture && (
        <ScheduleLectureModal
          onClose={() => setEditingLecture(null)}
          onSaved={handleLectureEdited}
          initial={editingLecture}
        />
      )}

      {/* KS-3803: «Расписание» — будущие scheduled-лекции, отсортированы
          по scheduledAt ASC (backend сортирует, но при оптимистичных
          вставках мы пересортируем сами). Своему автору на карточке —
          кнопки «Изменить» и «Отменить»; гостям только информация. */}
      {scheduledLectures.length > 0 && (
        <section
          className="coach-profile-section"
          data-testid="coach-profile-schedule-section"
          aria-label={t('coachProfile.scheduleTitle', 'Schedule')}
          style={{ marginTop: 24 }}
        >
          <h2>{t('coachProfile.scheduleTitle', 'Schedule')}</h2>
          <ul
            className="coach-profile-cards-grid"
            data-testid="coach-profile-schedule-grid"
            style={{
              listStyle: 'none',
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            {scheduledLectures.map((l) => {
              const absoluteLabel = formatStartedAt(
                l.scheduledAt,
                i18n.language,
              );
              const relativeLabel = l.scheduledAt
                ? formatRelativeToNow(l.scheduledAt, i18n.language)
                : '';
              return (
                <li
                  key={l.id}
                  className="coach-profile-schedule-card"
                  data-testid={`coach-profile-schedule-card-${l.id}`}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <Link
                    to={`/lectures/${l.id}`}
                    style={{
                      textDecoration: 'none',
                      color: 'inherit',
                      display: 'block',
                    }}
                    data-testid={`coach-profile-schedule-link-${l.id}`}
                  >
                    <header style={{ marginBottom: 4 }}>
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
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.7,
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {relativeLabel && (
                        <span
                          data-testid={`coach-profile-schedule-relative-${l.id}`}
                        >
                          {relativeLabel}
                        </span>
                      )}
                      {absoluteLabel && (
                        <span
                          data-testid={`coach-profile-schedule-absolute-${l.id}`}
                        >
                          {absoluteLabel}
                        </span>
                      )}
                    </div>
                  </Link>
                  {isOwnPage && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 8,
                        borderTop: '1px solid #eee',
                        paddingTop: 8,
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`coach-profile-schedule-edit-${l.id}`}
                        onClick={() =>
                          setEditingLecture({
                            id: l.id,
                            title: l.title,
                            description: l.description,
                            scheduledAt: l.scheduledAt ?? '',
                          })
                        }
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {t('lectureSchedule.actions.edit', 'Edit')}
                      </button>
                      <button
                        type="button"
                        data-testid={`coach-profile-schedule-cancel-${l.id}`}
                        onClick={() => void handleCancelLecture(l)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #d32f2f',
                          background: '#fff',
                          color: '#d32f2f',
                          cursor: 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {t('lectureSchedule.actions.cancel', 'Cancel')}
                      </button>
                      {/* KS-3867: «Удалить» доступно для всех статусов
                          кроме live (бэкенд вернёт 409). */}
                      <button
                        type="button"
                        data-testid={`coach-profile-schedule-delete-${l.id}`}
                        onClick={() => void handleDeleteLecture(l)}
                        disabled={deletingLectureId === l.id}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #999',
                          background: '#fff',
                          color: '#333',
                          cursor:
                            deletingLectureId === l.id ? 'wait' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {deletingLectureId === l.id
                          ? t('lectureDelete.deleting', 'Удаление…')
                          : t('lectureDelete.button', 'Удалить')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
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
                  {/* KS-3867: «Завершить лекцию» в карточке секции «В
                      эфире» — для владельца. Шлёт POST /lectures/:id/
                      force-end (KS-3864). Кнопки «Удалить» здесь нет:
                      backend запрещает удаление лекции в статусе live
                      (409). */}
                  {isOwnPage && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 10,
                        borderTop: '1px solid #eee',
                        paddingTop: 8,
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`coach-profile-live-end-${l.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleEndLecture(l);
                        }}
                        disabled={endingLectureId === l.id}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #d32f2f',
                          background: '#fff',
                          color: '#d32f2f',
                          cursor:
                            endingLectureId === l.id ? 'wait' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {endingLectureId === l.id
                          ? t('lectureLive.ending', 'Завершение…')
                          : t('lectureLive.endButton', 'Завершить лекцию')}
                      </button>
                    </div>
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
              // KS-3863 follow-up: в списке записанных лекций раньше
              // показывалась только дата окончания — при нескольких
              // записях в один день карточки выглядели одинаково, и
              // тренер не мог отличить одну от другой. Теперь
              // показываем «дата + время» окончания.
              const dateLabel = formatStartedAt(l.endedAt, i18n.language);
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
                  {/* KS-3867: «Удалить» доступно владельцу для recorded. */}
                  {isOwnPage && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 8,
                        borderTop: '1px solid #eee',
                        paddingTop: 8,
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`coach-profile-recording-delete-${l.id}`}
                        onClick={() => void handleDeleteLecture(l)}
                        disabled={deletingLectureId === l.id}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #999',
                          background: '#fff',
                          color: '#333',
                          cursor:
                            deletingLectureId === l.id ? 'wait' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {deletingLectureId === l.id
                          ? t('lectureDelete.deleting', 'Удаление…')
                          : t('lectureDelete.button', 'Удалить')}
                      </button>
                    </div>
                  )}
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
                  {/* KS-3867: «Удалить» доступно владельцу для cancelled. */}
                  {isOwnPage && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 8,
                        borderTop: '1px solid #eee',
                        paddingTop: 8,
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`coach-profile-finished-delete-${l.id}`}
                        onClick={() => void handleDeleteLecture(l)}
                        disabled={deletingLectureId === l.id}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 4,
                          border: '1px solid #999',
                          background: '#fff',
                          color: '#333',
                          cursor:
                            deletingLectureId === l.id ? 'wait' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        {deletingLectureId === l.id
                          ? t('lectureDelete.deleting', 'Удаление…')
                          : t('lectureDelete.button', 'Удалить')}
                      </button>
                    </div>
                  )}
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
