import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';

/**
 * `UserCourseOwnerActions` — блок действий владельца над пользова-
 * тельским курсом: Edit / Preview as student / Make public(private) /
 * Delete + блок Statistics для owner.
 *
 * KS-2653: вынесен из бывшего `UserCourseView` отдельным компонентом —
 * чтобы `CoursePage` мог рендерить унифицированный читательский шаблон
 * (общий для system и user) и поверх него подключать owner-actions
 * только если `course.ownerId === user.id`.
 *
 * Действия мутируют курс через `lessonsApi.updateCourse / deleteCourse`;
 * родитель синхронизируется через колбэки `onCourseUpdated` /
 * `onCourseDeleted`. Preview-режим (KS-2652) — кнопка `onEnterPreview`
 * принимает решение в родителе (он держит state preview-флага в URL).
 */
interface UserCourseOwnerActionsProps {
  course: UserCourseDto;
  onCourseUpdated: (next: UserCourseDto) => void;
  onCourseDeleted: () => void;
  onEdit: () => void;
  onEnterPreview: () => void;
}

export function UserCourseOwnerActions({
  course,
  onCourseUpdated,
  onCourseDeleted,
  onEdit,
  onEnterPreview,
}: UserCourseOwnerActionsProps) {
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
      onCourseUpdated(next);
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
      onCourseDeleted();
    } catch {
      setError(t('lessons.my.deleteError', 'Failed to delete course'));
      setBusy(false);
    }
  };

  return (
    <>
      {/* KS-1886: блок Statistics — виден только владельцу. BE отдаёт
          `course.stats` исключительно owner'у; рендерится здесь как
          часть owner-блока. */}
      {course.stats && (
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
        {/* KS-2652: «Preview as student» — переключает курс в preview-
            режим (owner-actions и stats скрываются, lesson-links
            пробрасывают `?preview=1`). */}
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
    </>
  );
}
