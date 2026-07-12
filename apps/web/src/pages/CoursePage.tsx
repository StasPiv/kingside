import { useCallback, useEffect, useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseLessonSummary,
  CourseWithLessonsResponse,
  UserCourseDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { ApiError } from '../ApiError';
import { groupLessonsByBlock } from '../components/lessons/courseBlocks';
import { CourseActiveLessonHero } from '../components/lessons/CourseActiveLessonHero';
import { UserCourseOwnerActions } from '../components/lessons/UserCourseOwnerActions';
import { useAuth } from '../context/AuthContext';
import { resolveInlineText } from '../utils/inlineI18nText';

/**
 * Страница `/lessons/:courseSlug` — курс с перечнем уроков и прогрессом
 * пользователя (L-07 + KS-1785).
 *
 * # KS-2645 (ADR-054 Phase D) — единая страница для system + user
 *
 * Один маршрут `/lessons/:courseSlug` отдаёт оба типа курсов.
 * Различение — по `course.ownerId`: null/отсутствует → системный,
 * UUID → пользовательский.
 *
 * # KS-2653 — единый визуальный шаблон system + user
 *
 * До KS-2653 пользовательский курс рендерился отдельным компонентом
 * (UserCourseView) с минималистичным UI без breadcrumb / hero /
 * прогресс-бара / lesson-cards. Жалоба пользователя (Telegram,
 * 2026-05-09) показала, что студент чужого пользовательского курса
 * получал «голый» список без точки входа на следующий урок.
 *
 * Теперь оба типа отрисованы по единому шаблону:
 *   1. breadcrumb «← All courses».
 *   2. header: title + (для user) Public/Private бейдж + description.
 *   3. progress-bar (если есть прогресс пользователя).
 *   4. owner-block (только владельцу user-курса): Statistics +
 *      Edit / Preview / Visibility / Delete (см. `UserCourseOwnerActions`).
 *   5. preview-bar (KS-2652) если автор включил preview-режим.
 *   6. CourseActiveLessonHero — банер «Continue / Start learning» с
 *      первым/следующим непройденным уроком.
 *   7. lesson-list — карточки уроков со статусом, шагами, бейджами
 *      Mastered/Due (только system).
 *
 * Адаптация DTO к общему shape выполняется через `adaptUserLessons` —
 * для user-уроков SM-2 поля недоступны (нейтральные дефолты), а
 * `progressState` берётся из реального `UserLessonDto.completedAt`
 * (KS-4920 / KS-4921).
 */

type CourseLoadData =
  | CourseWithLessonsResponse
  | UserCourseWithLessonsResponse;

/** Type-guard: `course.ownerId` есть → пользовательский курс. */
function isUserCourseResponse(
  data: CourseLoadData,
): data is UserCourseWithLessonsResponse {
  return (
    'ownerId' in data.course &&
    (data.course as UserCourseDto).ownerId != null
  );
}

/**
 * Адаптирует `UserLessonDto[]` к shape'у `CourseLessonSummary[]`,
 * который ждут `CourseActiveLessonHero` и lesson-cards. Часть полей
 * у user-уроков не существует (slug, blockKey, kind, masteredAt, dueAt),
 * заполняем нейтральными дефолтами.
 *
 * KS-4920: `progressState` — по РЕАЛЬНОМУ `lesson.completedAt`
 * (KS-4921: backend отдаёт его per-lesson). Прежняя эвристика «первые
 * `completedLessonsCount` уроков пройдены» врала, когда завершён не
 * префикс порядка (прод-кейс: завершён урок 2, урок 1 нет — пройденный
 * показывался «В процессе», hero зациклевал на него «Продолжить»).
 * Первый незавершённый по порядку — `in_progress` (цель hero),
 * остальные незавершённые — `not_started`.
 *
 * Fallback: если поле `completedAt` отсутствует во ВСЁМ списке
 * (старый ответ API из кэша), сохраняем прежнюю эвристику по
 * `completedLessonsCount` — хуже, чем факт, но лучше, чем «все не
 * начаты».
 */
export function adaptUserLessons(
  lessons: UserLessonDto[],
  completedLessonsCount: number,
): CourseLessonSummary[] {
  const hasCompletedAtField = lessons.some((l) => l.completedAt !== undefined);
  const firstUncompletedIdx = lessons.findIndex((l) => l.completedAt == null);
  return lessons.map((l, idx) => {
    let progressState: CourseLessonSummary['progressState'];
    if (hasCompletedAtField) {
      if (l.completedAt != null) progressState = 'completed';
      else if (idx === firstUncompletedIdx) progressState = 'in_progress';
      else progressState = 'not_started';
    } else if (idx < completedLessonsCount) progressState = 'completed';
    else if (idx === completedLessonsCount) progressState = 'in_progress';
    else progressState = 'not_started';
    return {
      id: l.id,
      // У user-уроков нет slug — используем UUID; LessonPage умеет
      // искать урок по slug ИЛИ id (см. KS-2645 lookup в LessonPage).
      slug: l.id,
      order: l.order,
      blockKey: '__user__',
      kind: 'theory',
      title: l.title,
      titleI18nKey: '',
      summary: null,
      summaryI18nKey: '',
      stepCount: l.stepCount,
      // У user-DTO нет per-lesson stepsState на уровне списка курса.
      // KS-4920: у завершённого урока прогресс-бар заполняем целиком
      // (иначе «Пройден» с пустым баром — вторая жалоба из тикета);
      // частичный прогресс незавершённых BE не отдаёт — бар пустой.
      completedStepsCount: progressState === 'completed' ? l.stepCount : 0,
      progressState,
      // SM-2 не подключён к user-курсам (ADR-026 §2.1).
      masteredAt: null,
      dueAt: null,
    };
  });
}

export function CoursePage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { courseSlug } = useParams<{ courseSlug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<CourseLoadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // KS-2099: при отсутствии перевода курса на текущем языке backend
  // возвращает 404 → отдельный экран «Курс недоступен на этом языке».
  const [unavailableInLang, setUnavailableInLang] = useState(false);

  // KS-2102: API больше НЕ принимает `?lang=` — backend читает
  // `User.locale` сам. `lang` в deps оставлен как триггер рефетча
  // после смены языка интерфейса.
  useEffect(() => {
    if (!courseSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUnavailableInLang(false);
    lessonsApi
      .getCourse(courseSlug)
      .then((res: CourseLoadData) => {
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
  const switchTo = useCallback(
    (target: 'ru' | 'en') => {
      void i18n.changeLanguage(target);
    },
    [i18n],
  );

  // KS-2652: preview-режим для автора. Хранится в `?preview=1`.
  const isUserCourse = data != null && isUserCourseResponse(data);
  const userCourseDto = isUserCourse
    ? (data as UserCourseWithLessonsResponse).course
    : null;
  const isOwner = Boolean(
    user && userCourseDto && user.id === userCourseDto.ownerId,
  );
  const previewActive =
    isOwner && searchParams.get('preview') === '1';
  const showOwnerUi = isOwner && !previewActive;

  const enterPreview = useCallback(() => {
    const sp = new URLSearchParams(searchParams);
    sp.set('preview', '1');
    setSearchParams(sp, { replace: false });
  }, [searchParams, setSearchParams]);

  const exitPreview = useCallback(() => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('preview');
    setSearchParams(sp, { replace: false });
  }, [searchParams, setSearchParams]);

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
              : t('lessons.courseUnavailableInLang.switchRu', 'Switch to Russian')}
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

  // ── Адаптация к общему шаблону ─────────────────────────────────────
  const { course, lessons } = data;
  const isUser = isUserCourseResponse(data);

  const courseTitle = isUser
    ? (course as UserCourseDto).title
    : resolveInlineText(
        (course as CourseWithLessonsResponse['course']).title,
        (course as CourseWithLessonsResponse['course']).titleI18nKey,
        t,
        course.slug,
      );
  const courseDescription = isUser
    ? (course as UserCourseDto).description ?? ''
    : resolveInlineText(
        (course as CourseWithLessonsResponse['course']).description,
        (course as CourseWithLessonsResponse['course']).descriptionI18nKey,
        t,
        '',
      );

  // Уроки в общем shape `CourseLessonSummary[]`, отсортированные по order.
  const sortedLessons: CourseLessonSummary[] = isUser
    ? adaptUserLessons(
        [...(lessons as UserLessonDto[])].sort((a, b) => a.order - b.order),
        (data as UserCourseWithLessonsResponse).progress
          ?.completedLessonsCount ?? 0,
      )
    : [...(lessons as CourseLessonSummary[])].sort(
        (a, b) => a.order - b.order,
      );

  // Прогресс курса: для system — `progress.lessonsCompleted`,
  // для user — `progress.completedLessonsCount`. Унифицируем в `done`.
  const total = sortedLessons.length;
  const done = isUser
    ? (data as UserCourseWithLessonsResponse).progress
        ?.completedLessonsCount ?? 0
    : (data as CourseWithLessonsResponse).progress?.lessonsCompleted ?? 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  // Группировка по блокам — только для system (у user blockOrder нет).
  // Для user всё в один блок.
  const blocks = isUser
    ? [{ key: '__user__', lessons: sortedLessons }]
    : groupLessonsByBlock(
        sortedLessons,
        (course as CourseWithLessonsResponse['course']).blockOrder ?? [],
      );

  // KS-2652: на preview/обычно lesson-links для user сохраняют
  // `?preview=1` — UserLessonView/LessonPage потом учтёт.
  const previewSuffix = previewActive ? '?preview=1' : '';
  const lessonHref = (lesson: CourseLessonSummary) =>
    `/lessons/${course.slug}/${lesson.slug}${previewSuffix}`;

  return (
    <div
      className="course-page"
      data-testid="course-page"
      data-course-type={isUser ? 'user' : 'system'}
      data-preview={previewActive ? 'true' : undefined}
    >
      <header className="course-header">
        <Link
          to="/lessons"
          className="course-back-link"
          data-testid="course-back-link"
        >
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        {/* KS-4140 / ADR-128 §11.2: гостю — inline-CTA, курс открыт
            для просмотра, прогресс не сохраняется. */}
        {!user && (
          <div className="guest-banner" data-testid="course-guest-banner">
            <Link to="/login">
              {t('auth.loginToSaveProgress', 'Sign in to save your progress')}
            </Link>
          </div>
        )}
        <div className="course-header__title-row">
          <h1 data-testid="course-title">{courseTitle}</h1>
          {/* KS-2653: бейдж видимости — только для пользовательского
              курса. У системных публичность подразумевается. */}
          {isUser && (
            <div className="course-header__badges">
              {(course as UserCourseDto).isPublic ? (
                <span
                  className="user-course-page__badge user-course-page__badge--public"
                  data-testid="user-course-public-badge"
                >
                  {t('lessons.my.publicBadge', 'Public')}
                </span>
              ) : (
                <span
                  className="user-course-page__badge user-course-page__badge--private"
                  data-testid="user-course-private-badge"
                >
                  {t('lessons.my.privateBadge', 'Private')}
                </span>
              )}
            </div>
          )}
        </div>
        {courseDescription && (
          <p className="course-description">{courseDescription}</p>
        )}
        {/* Прогресс курса — общий для system+user. На user это
            эвристика по completedLessonsCount (см. adaptUserLessons). */}
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
              completed: done,
              total,
              percent,
              defaultValue: '{{completed}}/{{total}} ({{percent}}%)',
            })}
          </span>
        </div>
      </header>

      {/* Owner-блок: Statistics + Edit/Preview/Visibility/Delete.
          Только в обычном (не-preview) режиме у владельца user-курса. */}
      {showOwnerUi && userCourseDto && (
        <UserCourseOwnerActions
          course={userCourseDto}
          onCourseUpdated={(next) =>
            setData((prev) =>
              prev && isUserCourseResponse(prev)
                ? { ...prev, course: next }
                : prev,
            )
          }
          onCourseDeleted={() => navigate('/lessons', { replace: true })}
          onEdit={() =>
            navigate(`/lessons/my/${userCourseDto.slug}/edit`)
          }
          onEnterPreview={enterPreview}
        />
      )}

      {/* KS-2652: preview-bar — только в preview-режиме. */}
      {previewActive && (
        <div
          className="user-course-page__preview-bar"
          data-testid="user-course-preview-bar"
          role="status"
        >
          <span className="user-course-page__preview-label">
            {t('lessons.my.preview.banner', 'Preview as student')}
          </span>
          <button
            type="button"
            className="user-course-page__preview-exit"
            data-testid="user-course-preview-exit"
            onClick={exitPreview}
          >
            {t('lessons.my.preview.exit', 'Exit preview')}
          </button>
        </div>
      )}

      {sortedLessons.length === 0 ? (
        <div className="lessons-empty" data-testid="course-no-lessons">
          {t('lessons.noLessons', 'No lessons in this course yet')}
        </div>
      ) : (
        <>
          {/* KS-2079 / KS-2653: hero «Continue / Start learning».
              Унифицирован для обоих типов курсов через адаптацию
              user-lessons → CourseLessonSummary с progressState
              эвристикой. CTA-ссылка строится `${course.slug}/${lesson.slug}`,
              где для user `lesson.slug = lesson.id` (UUID). */}
          <CourseActiveLessonHero
            courseSlug={course.slug}
            lessons={sortedLessons}
            previewSuffix={previewSuffix}
          />
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
                      to={lessonHref(lesson)}
                      data-testid={`lesson-link-${lesson.slug}`}
                      className="course-lesson-link"
                    >
                      <span className="course-lesson-title">
                        {isUser
                          ? lesson.title
                          : resolveInlineText(
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
                      {/* KS-1992: прогресс по шагам в карточке урока.
                          Для user `completedStepsCount` всегда 0
                          (BE не отдаёт per-lesson на уровне списка),
                          поэтому показывается просто «N steps». */}
                      {(() => {
                        const lessonTotal = lesson.stepCount || 0;
                        const lessonDone = lesson.completedStepsCount ?? 0;
                        const pct =
                          lessonTotal > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (lessonDone / lessonTotal) * 100,
                                ),
                              )
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
                              {lessonDone > 0
                                ? t('lessons.stepProgress', {
                                    done: lessonDone,
                                    total: lessonTotal,
                                    defaultValue:
                                      '{{done}}/{{total}} steps',
                                  })
                                : t('lessons.stepCount', {
                                    count: lessonTotal,
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
