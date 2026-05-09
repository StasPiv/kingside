import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserCourseDto,
  UserCoursePlayProgressDto,
  UserLessonDto,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { useAuth } from '../context/AuthContext';

/**
 * `UserCoursePage` — просмотр пользовательского курса с его уроками
 * (ADR-026 §2.6, KS-1838 / FE-4).
 *
 * Маршрут: `/lessons/my/:slug` (в `App.tsx`, без `<ProtectedRoute>` —
 * публичный курс доступен без auth; для owner-actions проверяем
 * `user?.id === course.ownerId` на клиенте, backend всё равно проверит).
 *
 * Загрузка: `userCoursesApi.getBySlug(slug)` отдаёт `{course, lessons,
 * progress}`. Backend:
 *  - публичный курс: 200 любому;
 *  - приватный: 200 только владельцу, 403/404 остальным — клиент
 *    маппит обе ветки в одинаковый `<NotFound>` (приватность → не
 *    выдаём факт существования курса, ADR §2.5).
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'ready'; course: UserCourseDto; lessons: UserLessonDto[]; progress: UserCoursePlayProgressDto | null };

export function UserCoursePage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    lessonsApi
      .getUserCourse(slug)
      .then((res) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          course: res.course,
          lessons: res.lessons,
          progress: res.progress,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'not_found' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.kind === 'loading') {
    return (
      <div className="loading" data-testid="user-course-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (state.kind === 'not_found') {
    // 404 — и «курс не существует», и «приватный чужой». Не раскрываем
    // факт существования приватного курса третьим лицам (ADR §2.5).
    return (
      <div className="user-course-404" data-testid="user-course-404">
        <h1>{t('lessons.my.notFoundTitle', 'Course not found')}</h1>
        <p>
          {t(
            'lessons.my.notFoundBody',
            'The course does not exist or is not available.',
          )}
        </p>
        <Link to="/lessons" data-testid="user-course-404-back">
          {t('lessons.backToList', 'Back to lessons')}
        </Link>
      </div>
    );
  }

  const { course, lessons, progress } = state;
  const isOwner = Boolean(user && user.id === course.ownerId);

  return (
    <div className="user-course-page" data-testid="user-course-page">
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

      {/* KS-1886: блок Statistics — виден только владельцу. BE
          отдаёт `course.stats` исключительно owner'у; дополнительно
          проверяем `isOwner` чтобы не показывать при гонке кеша. */}
      {isOwner && course.stats && (
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

      {isOwner && (
        <OwnerActions
          course={course}
          onVisibilityChanged={(next) =>
            setState((prev) =>
              prev.kind === 'ready' ? { ...prev, course: next } : prev,
            )
          }
          onDeleted={() => navigate('/lessons', { replace: true })}
          onEdit={() => navigate(`/lessons/my/${course.slug}/edit`)}
        />
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
                  to={`/lessons/my/${course.slug}/${lesson.id}`}
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
}

function OwnerActions({
  course,
  onVisibilityChanged,
  onDeleted,
  onEdit,
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

