import { useCallback, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserCourseDto,
  UserCoursePlayProgressDto,
  UserLessonDto,
} from '@kingside/shared';

import { lessonsApi } from '../../../api/lessonsApi';
import { useAuth } from '../../../context/AuthContext';

/**
 * `UserCourseView` — UI пользовательского курса (ADR-026 §2.6).
 *
 * KS-2645 (ADR-054 Phase D): раньше был отдельной страницей
 * `UserCoursePage` на маршруте `/lessons/my/:slug`. Теперь — внутренний
 * компонент-вид, рендерится из `CoursePage`, когда тот по ownerId курса
 * понимает что курс пользовательский. Маршрут `/lessons/my/:slug`
 * редиректит на `/lessons/:slug` (см. App.tsx).
 *
 * Загрузка данных делается родителем (`CoursePage`) — здесь только UI.
 * Owner-actions (publish toggle, delete) ходят на бэк через
 * `lessonsApi.updateCourse` / `deleteCourse`; родитель синхронизируется
 * через колбэки `onCourseUpdated` / `onCourseDeleted`.
 *
 * # KS-2652 — Preview-режим автора («Посмотреть как студент»)
 *
 * Автор может посмотреть свой курс глазами читателя без релогина под
 * другим аккаунтом. Активируется кнопкой в шапке курса; состояние
 * хранится в URL (`?preview=1`) — чтобы пережило reload и копию ссылки
 * на другой девайс.
 *
 * В preview:
 *   - owner-actions скрыты (Edit/Visibility/Delete);
 *   - блок Statistics скрыт (его и так backend отдаёт только owner'у,
 *     но в preview мы дополнительно скрываем на фронте — UX);
 *   - вместо owner-actions — кнопка «Вернуться к управлению» (Exit
 *     preview), снимает `?preview=1` из URL.
 *
 * Решение по прогрессу: в preview прогресс шагов сохраняется как
 * обычно (`useLessonProgress` бьёт в backend). Это проще, и не плодит
 * расхождения между «как у студента» и «реальное состояние автора».
 * Минус — автор «обнуляет» свой собственный прогресс, переходя в
 * preview, но у автора своих enrollment'ов на собственный курс
 * обычно нет.
 *
 * Линки на уроки из preview-режима пробрасывают `?preview=1` через
 * URL — чтобы reader тоже знал, что в preview, и (в будущем) скрывал
 * автор-специфичные подсказки.
 */

interface UserCourseViewProps {
  course: UserCourseDto;
  lessons: UserLessonDto[];
  progress: UserCoursePlayProgressDto | null;
  onCourseUpdated: (next: UserCourseDto) => void;
  onCourseDeleted: () => void;
}

export function UserCourseView({
  course,
  lessons,
  progress,
  onCourseUpdated,
  onCourseDeleted,
}: UserCourseViewProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // KS-2652: preview-режим только для владельца. Если в URL
  // `?preview=1` пришёл случайно (или скопирован с автор-сессии),
  // для НЕ-owner'а флаг игнорируем — у них и так UI без owner-actions.
  const isOwner = Boolean(user && user.id === course.ownerId);
  const previewActive = isOwner && searchParams.get('preview') === '1';
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

  // Хелпер: построить `to` для `<Link>` к уроку с пробросом
  // `?preview=1`, если активно. Чтобы preview-флаг не терялся при
  // переходе автор → reader.
  const lessonTo = useCallback(
    (lessonId: string) => {
      const base = `/lessons/${course.slug}/${lessonId}`;
      return previewActive ? `${base}?preview=1` : base;
    },
    [course.slug, previewActive],
  );

  return (
    <div
      className="user-course-page"
      data-testid="user-course-page"
      data-preview={previewActive ? 'true' : undefined}
    >
      <header className="user-course-page__header">
        <div className="user-course-page__meta">
          <h1 data-testid="user-course-title">{course.title}</h1>
          <div className="user-course-page__badges">
            {course.isPublic ? (
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
        </div>
        {course.description && (
          <p className="user-course-page__description">{course.description}</p>
        )}
        {progress && progress.completedAt ? (
          // KS-1882: банер «Курс пройден» — отображается, когда BE
          // зафиксировал `completedAt` на агрегате (KS-1881). При
          // добавлении нового урока в курс backend сбрасывает
          // completedAt → банер пропадает автоматически.
          <div
            className="user-course-page__completed-banner"
            data-testid="user-course-completed-banner"
            role="status"
          >
            <span
              className="user-course-page__completed-icon"
              aria-hidden="true"
            >
              ✓
            </span>
            <div className="user-course-page__completed-text">
              <strong>{t('lessons.completed.banner', 'Course completed')}</strong>
              <span className="user-course-page__completed-date">
                {t('lessons.completed.date', {
                  date: new Date(progress.completedAt).toLocaleDateString(),
                  defaultValue: 'on {{date}}',
                })}
              </span>
            </div>
          </div>
        ) : (
          progress && (
            <p
              className="user-course-page__progress"
              data-testid="user-course-progress"
            >
              {t('lessons.my.progress', {
                count: course.lessonCount,
                done: progress.completedLessonsCount,
                defaultValue: 'Completed {{done}}/{{count}} lessons',
              })}
            </p>
          )
        )}
      </header>

      {/* KS-1886: блок Statistics — виден только владельцу.
          KS-2652: в preview-режиме автор смотрит «как студент» —
          стат-блок тоже скрыт, иначе UI не похож на читательский. */}
      {showOwnerUi && course.stats && (
        <section
          className="user-course-page__stats"
          data-testid="user-course-stats"
          aria-label={t('lessons.my.stats.title', 'Statistics')}
        >
          <h3 className="user-course-page__stats-title">
            {t('lessons.my.stats.title', 'Statistics')}
          </h3>
          <dl className="user-course-page__stats-grid">
            <div className="user-course-page__stats-item">
              <dt>{t('lessons.my.stats.enrolledLabel', 'Enrolled')}</dt>
              <dd data-testid="user-course-stats-enrolled">
                {course.stats.enrolledCount}
              </dd>
            </div>
            <div className="user-course-page__stats-item">
              <dt>{t('lessons.my.stats.completedLabel', 'Completed')}</dt>
              <dd data-testid="user-course-stats-completed">
                {course.stats.completedCount}
                {course.stats.enrolledCount > 0 && (
                  <span className="user-course-page__stats-percent">
                    {' '}
                    ({Math.round(
                      (course.stats.completedCount /
                        course.stats.enrolledCount) *
                        100,
                    )}
                    %)
                  </span>
                )}
              </dd>
            </div>
            <div className="user-course-page__stats-item">
              <dt>{t('lessons.my.stats.inProgressLabel', 'In progress')}</dt>
              <dd data-testid="user-course-stats-in-progress">
                {course.stats.inProgressCount}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* KS-2652: для owner'а вместо owner-actions в preview-режиме
          показываем кнопку «Вернуться к управлению» (Exit preview).
          В обычном режиме — все три кнопки + новая «Посмотреть как
          студент» (Enter preview). */}
      {showOwnerUi && (
        <OwnerActions
          course={course}
          onVisibilityChanged={onCourseUpdated}
          onDeleted={onCourseDeleted}
          onEdit={() => navigate(`/lessons/my/${course.slug}/edit`)}
          onEnterPreview={enterPreview}
        />
      )}
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

      <section
        className="user-course-page__lessons"
        data-testid="user-course-lessons"
      >
        <h2>
          {t('lessons.my.editor.lessonsTitle', 'Lessons')}{' '}
          <span className="user-course-page__count">
            ({lessons.length})
          </span>
        </h2>

        {lessons.length === 0 && (
          <p
            className="user-course-page__empty"
            data-testid="user-course-lessons-empty"
          >
            {t('lessons.my.editor.lessonsEmpty', 'No lessons yet')}
          </p>
        )}

        <ul className="user-course-page__lesson-grid">
          {lessons
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((lesson) => (
              <li
                key={lesson.id}
                className="user-course-page__lesson-card"
                data-testid={`user-course-lesson-${lesson.id}`}
              >
                <div className="user-course-page__lesson-meta">
                  <h3 className="user-course-page__lesson-title">
                    {lesson.title}
                  </h3>
                  <span className="user-course-page__lesson-steps">
                    {t('lessons.stepCount', {
                      count: lesson.stepCount,
                      defaultValue: '{{count}} steps',
                    })}
                  </span>
                </div>
                <Link
                  to={lessonTo(lesson.id)}
                  className="user-course-page__lesson-cta"
                  data-testid={`user-course-lesson-play-${lesson.id}`}
                >
                  {t('lessons.my.open', 'Open')}
                </Link>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

// ─── Owner actions ────────────────────────────────────────────────────

interface OwnerActionsProps {
  course: UserCourseDto;
  onVisibilityChanged: (next: UserCourseDto) => void;
  onDeleted: () => void;
  onEdit: () => void;
  onEnterPreview: () => void;
}

function OwnerActions({
  course,
  onVisibilityChanged,
  onDeleted,
  onEdit,
  onEnterPreview,
}: OwnerActionsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<false | 'visibility' | 'delete'>(false);
  const [error, setError] = useState<string | null>(null);

  const toggleVisibility = async () => {
    setBusy('visibility');
    setError(null);
    try {
      const next = await lessonsApi.updateCourse(course.id, {
        isPublic: !course.isPublic,
      });
      onVisibilityChanged(next);
    } catch {
      setError(t('lessons.my.visibilityError', 'Failed to update visibility'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    const ok = window.confirm(
      t('lessons.my.deleteConfirmBody', {
        title: course.title,
        defaultValue: 'Delete course "{{title}}"?',
      }),
    );
    if (!ok) return;
    setBusy('delete');
    setError(null);
    try {
      await lessonsApi.deleteCourse(course.id);
      onDeleted();
    } catch {
      setError(t('lessons.my.deleteError', 'Failed to delete course'));
      setBusy(false);
    }
  };

  return (
    <div
      className="user-course-page__owner-actions"
      data-testid="user-course-owner-actions"
    >
      <button
        type="button"
        onClick={onEdit}
        data-testid="user-course-edit"
      >
        {t('lessons.my.edit', 'Edit')}
      </button>
      {/* KS-2652: «Посмотреть как студент» — переключает курс в
          preview-режим (owner-actions и stats скрываются, lesson-links
          пробрасывают `?preview=1`). Расположена рядом с другими
          owner-actions, доступна тому же owner'у. */}
      <button
        type="button"
        onClick={onEnterPreview}
        data-testid="user-course-preview-enter"
      >
        {t('lessons.my.preview.enter', 'Preview as student')}
      </button>
      <button
        type="button"
        onClick={toggleVisibility}
        disabled={busy !== false}
        data-testid="user-course-toggle-visibility"
      >
        {busy === 'visibility'
          ? t('lessons.my.visibilityPending', 'Updating…')
          : course.isPublic
          ? t('lessons.my.makePrivate', 'Make private')
          : t('lessons.my.makePublic', 'Make public')}
      </button>
      <button
        type="button"
        onClick={handleDelete}
        disabled={busy !== false}
        className="user-course-page__delete"
        data-testid="user-course-delete"
      >
        {busy === 'delete'
          ? t('lessons.my.editor.saving', 'Saving…')
          : t('lessons.my.delete', 'Delete')}
      </button>

      {error && (
        <p
          className="user-course-page__owner-error"
          data-testid="user-course-owner-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
