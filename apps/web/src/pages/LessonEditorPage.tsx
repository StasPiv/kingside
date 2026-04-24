import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseLevel, LessonKind, LessonStepType } from '@kingside/shared';

import { useAuth } from '../context/AuthContext';
import {
  createEmptyCourse,
  createEmptyLesson,
  createEmptyStep,
} from '../types/editor';
import type { CourseFixture, LessonFixture, StepFixture } from '../types/editor';
import { StepEditor } from '../components/lessons/editor/StepEditor';
import { exportCourseFixture, triggerDownload } from '../utils/exportFixture';

/**
 * Редактор уроков (L-27 / KS-1805).
 *
 * Form-based UI для сборки `CourseFixture` под seed без записи в БД —
 * экспорт даёт готовый `.ts` модуль в формате backend'ного `CourseFixture`,
 * пригодный для вставки в `apps/api/src/lessons/seed/courses/<slug>/`.
 *
 * # Role-guard
 *
 * Страница доступна только пользователям с email из whitelist'а
 * `VITE_LESSON_EDITOR_EMAILS` (запятыми). Неавторизованные / не-белые
 * видят заглушку. Это MVP-уровень guard'а (ролей в проекте пока нет) —
 * полноценный RBAC приходит позже.
 */

export function isEmailAllowedForEditor(
  email: string | undefined,
  whitelist: string,
): boolean {
  if (!email) return false;
  const allowed = whitelist
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  // `*` — dev-only wildcard: пропускает любого залогиненного.
  // В prod-env переменная должна содержать конкретные email'ы.
  if (allowed.includes('*')) return true;
  return allowed.includes(email.toLowerCase());
}

export function LessonEditorPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const whitelist = import.meta.env.VITE_LESSON_EDITOR_EMAILS ?? '';
  const allowed = isEmailAllowedForEditor(user?.email, whitelist);

  const [course, setCourse] = useState<CourseFixture>(() => createEmptyCourse());
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const selectedLesson = useMemo(
    () => course.lessons.find((l) => l.id === selectedLessonId) ?? null,
    [course.lessons, selectedLessonId],
  );

  if (!user) {
    return (
      <div
        className="lesson-editor lesson-editor--denied"
        data-testid="lesson-editor-denied"
      >
        <p>{t('editor.notLoggedIn', 'Please log in to access the editor.')}</p>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div
        className="lesson-editor lesson-editor--denied"
        data-testid="lesson-editor-denied"
      >
        <h1>{t('editor.title', 'Lesson editor')}</h1>
        <p>
          {t(
            'editor.forbidden',
            "You don't have access to the lesson editor. Contact admin to be added to the whitelist.",
          )}
        </p>
        <Link to="/lessons">{t('lessons.backToList', 'All courses')}</Link>
      </div>
    );
  }

  // ─── Course actions ────────────────────────────────────────────────
  const updateCourse = <K extends keyof CourseFixture>(
    key: K,
    value: CourseFixture[K],
  ) => {
    setCourse((c) => ({ ...c, [key]: value }));
  };

  // ─── Lesson actions ────────────────────────────────────────────────
  const addLesson = () => {
    setCourse((c) => {
      const nextLesson = createEmptyLesson(c.lessons.length + 1);
      setSelectedLessonId(nextLesson.id);
      return { ...c, lessons: [...c.lessons, nextLesson] };
    });
  };

  const updateLesson = (lessonId: string, updater: (l: LessonFixture) => LessonFixture) => {
    setCourse((c) => ({
      ...c,
      lessons: c.lessons.map((l) => (l.id === lessonId ? updater(l) : l)),
    }));
  };

  const removeLesson = (lessonId: string) => {
    setCourse((c) => {
      const next = c.lessons
        .filter((l) => l.id !== lessonId)
        .map((l, i) => ({ ...l, order: i + 1 }));
      return { ...c, lessons: next };
    });
    if (selectedLessonId === lessonId) setSelectedLessonId(null);
  };

  const moveLesson = (lessonId: string, delta: -1 | 1) => {
    setCourse((c) => {
      const idx = c.lessons.findIndex((l) => l.id === lessonId);
      if (idx < 0) return c;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= c.lessons.length) return c;
      const next = c.lessons.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(newIdx, 0, moved);
      return { ...c, lessons: next.map((l, i) => ({ ...l, order: i + 1 })) };
    });
  };

  // ─── Step actions ──────────────────────────────────────────────────
  const addStep = (lessonId: string) => {
    updateLesson(lessonId, (l) => ({
      ...l,
      steps: [...l.steps, createEmptyStep(l.steps.length + 1)],
    }));
  };

  const updateStep = (lessonId: string, stepId: string, next: StepFixture) => {
    updateLesson(lessonId, (l) => ({
      ...l,
      steps: l.steps.map((s) => (s.id === stepId ? next : s)),
    }));
  };

  const removeStep = (lessonId: string, stepId: string) => {
    updateLesson(lessonId, (l) => ({
      ...l,
      steps: l.steps
        .filter((s) => s.id !== stepId)
        .map((s, i) => ({ ...s, order: i + 1 })),
    }));
  };

  const moveStep = (lessonId: string, stepId: string, delta: -1 | 1) => {
    updateLesson(lessonId, (l) => {
      const idx = l.steps.findIndex((s) => s.id === stepId);
      if (idx < 0) return l;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= l.steps.length) return l;
      const next = l.steps.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(newIdx, 0, moved);
      return { ...l, steps: next.map((s, i) => ({ ...s, order: i + 1 })) };
    });
  };

  // ─── Export ────────────────────────────────────────────────────────
  const handleExport = () => {
    // Базовая клиент-валидация: slug курса обязателен, как и slug каждого урока.
    const issues: string[] = [];
    if (!course.slug.trim()) issues.push('Course slug is required');
    if (!course.titleI18nKey.trim())
      issues.push('Course titleI18nKey is required');
    course.lessons.forEach((l, i) => {
      if (!l.slug.trim()) issues.push(`Lesson #${i + 1} slug is required`);
    });
    if (issues.length > 0) {
      setStatusMsg(issues.join('; '));
      return;
    }
    const content = exportCourseFixture(course);
    triggerDownload(`${course.slug || 'course'}.ts`, content);
    setStatusMsg(t('editor.exported', 'Fixture exported.'));
  };

  return (
    <div className="lesson-editor" data-testid="lesson-editor">
      <header className="lesson-editor__header">
        <h1>{t('editor.title', 'Lesson editor')}</h1>
        <p className="lesson-editor__subtitle">
          {t(
            'editor.subtitle',
            'Build a course fixture locally and export it as a .ts file.',
          )}
        </p>
        <Link to="/lessons" className="lesson-editor__back">
          ← {t('lessons.backToList', 'All courses')}
        </Link>
      </header>

      <section className="lesson-editor__course" data-testid="lesson-editor-course">
        <h2>{t('editor.course.title', 'Course')}</h2>
        <div className="lesson-editor__course-fields">
          <label>
            {t('editor.course.slug', 'Slug')}
            <input
              value={course.slug}
              onChange={(e) => updateCourse('slug', e.target.value)}
              data-testid="editor-course-slug"
            />
          </label>
          <label>
            {t('editor.course.level', 'Level')}
            <select
              value={course.level}
              onChange={(e) =>
                updateCourse('level', e.target.value as CourseLevel)
              }
              data-testid="editor-course-level"
            >
              <option value="beginner">beginner</option>
              <option value="intermediate">intermediate</option>
              <option value="advanced">advanced</option>
            </select>
          </label>
          <label>
            titleI18nKey
            <input
              value={course.titleI18nKey}
              onChange={(e) => updateCourse('titleI18nKey', e.target.value)}
              data-testid="editor-course-title-key"
            />
          </label>
          <label>
            descriptionI18nKey
            <input
              value={course.descriptionI18nKey}
              onChange={(e) => updateCourse('descriptionI18nKey', e.target.value)}
            />
          </label>
          <label>
            {t('editor.course.order', 'Order')}
            <input
              type="number"
              value={course.order}
              onChange={(e) => updateCourse('order', Number(e.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={course.isPublished}
              onChange={(e) => updateCourse('isPublished', e.target.checked)}
              data-testid="editor-course-published"
            />
            {t('editor.course.isPublished', 'Published')}
          </label>
        </div>
      </section>

      <section
        className="lesson-editor__lessons"
        data-testid="lesson-editor-lessons"
      >
        <header className="lesson-editor__section-header">
          <h2>{t('editor.lessons.title', 'Lessons')}</h2>
          <button
            type="button"
            onClick={addLesson}
            data-testid="editor-add-lesson"
          >
            + {t('editor.lessons.add', 'Add lesson')}
          </button>
        </header>
        {course.lessons.length === 0 && (
          <p
            className="lesson-editor__empty"
            data-testid="editor-lessons-empty"
          >
            {t('editor.lessons.empty', 'No lessons yet.')}
          </p>
        )}
        <ol className="lesson-editor__lesson-list">
          {course.lessons.map((lesson) => (
            <li
              key={lesson.id}
              className={`lesson-editor__lesson-item${selectedLessonId === lesson.id ? ' lesson-editor__lesson-item--active' : ''}`}
              data-testid={`editor-lesson-${lesson.id}`}
            >
              <button
                type="button"
                onClick={() => setSelectedLessonId(lesson.id)}
                className="lesson-editor__lesson-select"
                data-testid={`editor-lesson-select-${lesson.id}`}
              >
                #{lesson.order} — {lesson.slug || '<slug>'}
              </button>
              <div className="lesson-editor__lesson-actions">
                <button
                  type="button"
                  onClick={() => moveLesson(lesson.id, -1)}
                  data-testid={`editor-lesson-up-${lesson.id}`}
                  title={t('editor.moveUp', 'Move up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveLesson(lesson.id, 1)}
                  data-testid={`editor-lesson-down-${lesson.id}`}
                  title={t('editor.moveDown', 'Move down')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeLesson(lesson.id)}
                  data-testid={`editor-lesson-remove-${lesson.id}`}
                  className="lesson-editor__lesson-remove"
                >
                  {t('editor.remove', 'Remove')}
                </button>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {selectedLesson && (
        <section
          className="lesson-editor__lesson-editor"
          data-testid="lesson-editor-lesson-editor"
        >
          <h2>
            {t('editor.lesson.title', 'Lesson')}: #{selectedLesson.order}{' '}
            {selectedLesson.slug || '<slug>'}
          </h2>
          <div className="lesson-editor__lesson-fields">
            <label>
              slug
              <input
                value={selectedLesson.slug}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    slug: e.target.value,
                  }))
                }
                data-testid="editor-lesson-slug"
              />
            </label>
            <label>
              blockKey
              <input
                value={selectedLesson.blockKey}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    blockKey: e.target.value,
                  }))
                }
              />
            </label>
            <label>
              kind
              <select
                value={selectedLesson.kind}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    kind: e.target.value as LessonKind,
                  }))
                }
              >
                <option value="theory">theory</option>
                <option value="tactics_set">tactics_set</option>
                <option value="endgame_set">endgame_set</option>
                <option value="opening_line">opening_line</option>
                <option value="game_review">game_review</option>
                <option value="quiz">quiz</option>
              </select>
            </label>
            <label>
              titleI18nKey
              <input
                value={selectedLesson.titleI18nKey}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    titleI18nKey: e.target.value,
                  }))
                }
              />
            </label>
            <label>
              summaryI18nKey
              <input
                value={selectedLesson.summaryI18nKey}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    summaryI18nKey: e.target.value,
                  }))
                }
              />
            </label>
            <label>
              estMinutes
              <input
                type="number"
                min={1}
                value={selectedLesson.estMinutes}
                onChange={(e) =>
                  updateLesson(selectedLesson.id, (l) => ({
                    ...l,
                    estMinutes: Math.max(1, Number(e.target.value)),
                  }))
                }
              />
            </label>
          </div>

          <header className="lesson-editor__section-header">
            <h3>{t('editor.steps.title', 'Steps')}</h3>
            <button
              type="button"
              onClick={() => addStep(selectedLesson.id)}
              data-testid="editor-add-step"
            >
              + {t('editor.steps.add', 'Add step')}
            </button>
          </header>

          {selectedLesson.steps.length === 0 && (
            <p
              className="lesson-editor__empty"
              data-testid="editor-steps-empty"
            >
              {t('editor.steps.empty', 'No steps yet.')}
            </p>
          )}

          <ol className="lesson-editor__step-list">
            {selectedLesson.steps.map((step, i) => (
              <li key={step.id}>
                <StepEditor
                  step={step}
                  onChange={(next) => updateStep(selectedLesson.id, step.id, next)}
                  onRemove={() => removeStep(selectedLesson.id, step.id)}
                  onMoveUp={
                    i > 0
                      ? () => moveStep(selectedLesson.id, step.id, -1)
                      : undefined
                  }
                  onMoveDown={
                    i < selectedLesson.steps.length - 1
                      ? () => moveStep(selectedLesson.id, step.id, 1)
                      : undefined
                  }
                />
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="lesson-editor__footer">
        <button
          type="button"
          className="lesson-editor__export-btn"
          onClick={handleExport}
          data-testid="editor-export-btn"
        >
          {t('editor.export', 'Export .ts fixture')}
        </button>
        {statusMsg && (
          <p className="lesson-editor__status" data-testid="editor-status">
            {statusMsg}
          </p>
        )}
      </footer>
    </div>
  );
}

// Псевдонимный тип, чтобы TS-проверялся при использовании setSteps в StepEditor.
export type EditorStepType = LessonStepType;
