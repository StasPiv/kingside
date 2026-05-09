import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseWithLessonsResponse,
  UserCourseDto,
  UserCourseWithLessonsResponse,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { ApiError } from '../ApiError';
import { groupLessonsByBlock } from '../components/lessons/courseBlocks';
import { CourseActiveLessonHero } from '../components/lessons/CourseActiveLessonHero';
import { UserCourseView } from '../components/lessons/views/UserCourseView';
import { resolveInlineText } from '../utils/inlineI18nText';

/**
 * Страница `/lessons/:courseSlug` — курс с перечнем уроков и прогрессом
 * пользователя (L-07 + KS-1785).
 *
 * Уроки сгруппированы по «блокам» через `groupLessonsByBlock` (см.
 * `components/lessons/courseBlocks.ts`). До появления `blockKey` в
 * API используется slug-fallback для курса beginner.
 *
 * # KS-2645 (ADR-054 Phase D) — единая страница для system + user
 *
 * Один маршрут `/lessons/:courseSlug` теперь отдаёт оба типа курсов.
 * Различение по `course.ownerId`:
 *   - `null` / отсутствует → системный курс (текущий UI с blocks/hero/
 *     SM-2 mastered/due бейджами);
 *   - UUID → пользовательский курс — рендерится `<UserCourseView>`.
 *
 * Старый маршрут `/lessons/my/:slug` (UserCoursePage) удалён;
 * App.tsx редиректит его на `/lessons/:slug` (см. `Navigate replace`).
 */

/** Type-guard: `course.ownerId` есть → пользовательский курс. */
function isUserCourseResponse(
  data: CourseWithLessonsResponse | UserCourseWithLessonsResponse,
): data is UserCourseWithLessonsResponse {
  return (
    'ownerId' in data.course &&
    (data.course as UserCourseDto).ownerId != null
  );
}

export function CoursePage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { courseSlug } = useParams<{ courseSlug: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<
    CourseWithLessonsResponse | UserCourseWithLessonsResponse | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // KS-2099: при отсутствии перевода курса на текущем языке backend
  // возвращает 404. На фронте это отдельный экран «Курс недоступен на
  // этом языке» с предложением переключить язык — фолбэка на ru нет
  // (поведение Acceptance из задачи).
  const [unavailableInLang, setUnavailableInLang] = useState(false);

  // KS-2102: API больше НЕ принимает `?lang=` — backend читает
  // `User.locale` сам. `lang` в deps оставлен как триггер рефетча
  // после смены языка интерфейса (см. MainLayout — там
  // PATCH /users/me/settings + i18n.changeLanguage).
  useEffect(() => {
    if (!courseSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUnavailableInLang(false);
    lessonsApi
      .getCourse(courseSlug)
      .then((res: CourseWithLessonsResponse | UserCourseWithLessonsResponse) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setUnavailableInLang(true);
          setData(null);
          return;
        }
        setError(t('lessons.loadError', 'Failed to load course'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseSlug, t, lang]);

  // KS-2099: переключение языка из экрана «недоступно на этом языке».
  // `i18n.changeLanguage` подхватит rerender списочной страницы и
  // эффекта здесь — getCourse уйдёт повторно с новым lang.
  const switchTo = useCallback(
    (target: 'ru' | 'en') => {
      void i18n.changeLanguage(target);
    },
    [i18n],
  );

  if (!courseSlug) {
    return (
      <div className="error" data-testid="course-error">
        {t('lessons.invalidCourse', 'Invalid course slug')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="loading" data-testid="course-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error" data-testid="course-error">
        {error}
      </div>
    );
  }

  if (unavailableInLang) {
    // KS-2099: на текущем UI-языке курс недоступен. Предлагаем
    // переключить язык на «противоположный» — у нас всего две
    // локали (ru/en), поэтому фолбэк всегда однозначен.
    const isEn = lang.toLowerCase().startsWith('en');
    const altLang: 'ru' | 'en' = isEn ? 'ru' : 'en';
    return (
      <div
        className="lessons-empty course-unavailable"
        data-testid="course-unavailable-in-lang"
        data-lang={isEn ? 'en' : 'ru'}
      >
        <h1>
          {t(
            'lessons.courseUnavailableInLang.title',
            'Course is not available in this language',
          )}
        </h1>
        <p>
          {t(
            'lessons.courseUnavailableInLang.description',
            'This course has not been translated yet. Switch the interface language to access another version.',
          )}
        </p>
        <div className="course-unavailable-actions">
          <button
            type="button"
            className="course-unavailable-switch"
            data-testid="course-unavailable-switch-lang"
            onClick={() => switchTo(altLang)}
          >
            {altLang === 'en'
              ? t('lessons.courseUnavailableInLang.switchEn', 'Switch to English')
              : t('lessons.courseUnavailableInLang.switchRu', 'Переключиться на русский')}
          </button>
          <Link
            to="/lessons"
            className="course-unavailable-back"
            data-testid="course-unavailable-back-link"
          >
            ← {t('lessons.backToList', 'All courses')}
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="lessons-empty" data-testid="course-empty">
        {t('lessons.courseNotFound', 'Course not found')}
      </div>
    );
  }

  // KS-2645: пользовательский курс — отдельный UI (бейджи Public/Private,
  // owner-actions, плоский lesson-список без blocks). После всех
  // глобальных guards (loading/error/empty/unavailableInLang) переключаем
  // ветку рендера.
  if (isUserCourseResponse(data)) {
    return (
      <UserCourseView
        course={data.course}
        lessons={data.lessons}
        progress={data.progress}
        onCourseUpdated={(next) =>
          setData((prev) =>
            prev && isUserCourseResponse(prev)
              ? { ...prev, course: next }
              : prev,
          )
        }
        onCourseDeleted={() => navigate('/lessons', { replace: true })}
      />
    );
  }

  const { course, lessons, progress } = data;
  const sortedLessons = [...lessons].sort((a, b) => a.order - b.order);
  // KS-2038: порядок блоков теперь приходит с бэка в `course.blockOrder`
  // (см. KS-2037). Если поле пустое/отсутствует — `groupLessonsByBlock`
  // упорядочит блоки по первому появлению в `lessons`.
  const blocks = groupLessonsByBlock(sortedLessons, course.blockOrder ?? []);
  const total = sortedLessons.length;
  const completed = progress?.lessonsCompleted ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="course-page" data-testid="course-page">
      <header className="course-header">
        <Link to="/lessons" className="course-back-link" data-testid="course-back-link">
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        <h1>
          {resolveInlineText(course.title, course.titleI18nKey, t, course.slug)}
        </h1>
        <p className="course-description">
          {resolveInlineText(course.description, course.descriptionI18nKey, t, '')}
        </p>
        <div
          className="course-progress"
          data-testid="course-progress"
          aria-label={t('lessons.progressLabel', 'Course progress')}
        >
          <div className="course-progress-bar">
            <div
              className="course-progress-fill"
              style={{ width: `${percent}%` }}
              data-testid="course-progress-fill"
            />
          </div>
          <span className="course-progress-text">
            {t('lessons.progressFull', {
              completed,
              total,
              percent,
              defaultValue: '{{completed}}/{{total}} ({{percent}}%)',
            })}
          </span>
        </div>
      </header>

      {sortedLessons.length === 0 ? (
        <div className="lessons-empty" data-testid="course-no-lessons">
          {t('lessons.noLessons', 'No lessons in this course yet')}
        </div>
      ) : (
        <>
          {/* KS-2079: hero-плашка активного урока. Сама компонента решает
              три кейса (continue / start / completed). На пустом курсе
              возвращает null — поэтому ничего не рисует. */}
          <CourseActiveLessonHero
            courseSlug={course.slug}
            lessons={sortedLessons}
          />
          {/* KS-2039: единый плоский список уроков. Раньше уроки
              группировались в `<section>`-блоки с заголовками
              («Правила и фигуры», «Базовые маты», …) — каждый title
              урока уже несёт свой раздел (§N), заголовок-секция
              дублировал контекст. Теперь визуально это сплошной список
              сверху вниз; порядок задаёт `course.blockOrder` через
              `groupLessonsByBlock(...).flatMap(...)` — внутри блока
              сортировка по `lesson.order`. */}
          <ol
            className="course-lesson-list"
            data-testid="course-lesson-list"
          >
          {blocks
            .flatMap((b) => b.lessons)
            .map((lesson) => {
              const isMastered = Boolean(lesson.masteredAt);
              const isDue =
                Boolean(lesson.dueAt) &&
                new Date(lesson.dueAt as string).getTime() <= Date.now();
              return (
                <li
                  key={lesson.id}
                  className={`course-lesson-item course-lesson-item--${lesson.progressState}`}
                  data-mastered={isMastered ? 'true' : 'false'}
                  data-due={isDue ? 'true' : 'false'}
                >
                  <Link
                    to={`/lessons/${course.slug}/${lesson.slug}`}
                    data-testid={`lesson-link-${lesson.slug}`}
                    className="course-lesson-link"
                  >
                    {/* KS-1991: индекс убран — был рудимент.
                        Заголовки уроков несут собственную нумерацию
                        («Глава 1. …»), внешний индекс дублировал. */}
                    <span className="course-lesson-title">
                      {resolveInlineText(
                        lesson.title,
                        lesson.titleI18nKey,
                        t,
                        lesson.slug,
                      )}
                    </span>
                    <span
                      className={`course-lesson-state course-lesson-state--${lesson.progressState}`}
                    >
                      {t(
                        `lessons.state.${lesson.progressState}`,
                        lesson.progressState,
                      )}
                    </span>
                    {isMastered && (
                      <span
                        className="course-lesson-badge course-lesson-badge--mastered"
                        data-testid={`course-lesson-mastered-${lesson.slug}`}
                      >
                        {t('lessons.badge.mastered', 'Mastered')}
                      </span>
                    )}
                    {isDue && (
                      <span
                        className="course-lesson-badge course-lesson-badge--due"
                        data-testid={`course-lesson-due-${lesson.slug}`}
                      >
                        {t('lessons.badge.dueForReview', 'Due for review')}
                      </span>
                    )}
                    {/* KS-1992: прогресс по шагам в карточке урока —
                        визуальный bar + текст. Полоска заполняется
                        пропорционально `completedStepsCount/stepCount`;
                        если ничего не сделано, bar пустой, рядом
                        общий счётчик «M шагов». */}
                    {(() => {
                      const total = lesson.stepCount || 0;
                      const done = lesson.completedStepsCount ?? 0;
                      const pct =
                        total > 0
                          ? Math.min(100, Math.round((done / total) * 100))
                          : 0;
                      return (
                        <span
                          className="course-lesson-progress"
                          data-testid={`course-lesson-progress-${lesson.slug}`}
                          aria-label={t(
                            'lessons.progressLabel',
                            'Course progress',
                          )}
                        >
                          <span className="course-lesson-progress-bar">
                            <span
                              className="course-lesson-progress-fill"
                              data-testid={`course-lesson-progress-fill-${lesson.slug}`}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className="course-lesson-step-count"
                            data-testid={`course-lesson-step-count-${lesson.slug}`}
                          >
                            {done > 0
                              ? t('lessons.stepProgress', {
                                  done,
                                  total,
                                  defaultValue: '{{done}}/{{total}} steps',
                                })
                              : t('lessons.stepCount', {
                                  count: total,
                                  defaultValue: '{{count}} steps',
                                })}
                          </span>
                        </span>
                      );
                    })()}
                  </Link>
                </li>
              );
            })}
        </ol>
        </>
      )}
    </div>
  );
}
