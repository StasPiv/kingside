import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserCourseDto,
  UserLessonDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
  UserStepType,
} from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { StepEditor } from '../components/lessons/editor/StepEditor';
import type { StepFixture } from '../types/editor';
import { emptyStepPayload } from '../types/editor';

/**
 * `UserCourseEditorPage` — конструктор пользовательского курса
 * (ADR-026 §2.6, KS-1837 / FE-3).
 *
 * Маршрут: `/lessons/my/:slug/edit` (добавляется в `App.tsx` за
 * `<ProtectedRoute>`). Owner-guard — на клиенте: если `course.ownerId`
 * не совпадает с текущим `user.id`, делаем редирект на `/lessons`
 * (backend всё равно отдаст 403/404 на PATCH чужого; клиентский guard —
 * про мгновенный UX).
 *
 * Формы сохраняются **debounced PATCH'ом** с задержкой 500 мс. Каждый
 * инпут мгновенно меняет локальный `state`, а реальный запрос уходит
 * после паузы. Добавление/удаление уроков и шагов — немедленные POST/DELETE
 * (это дискретные действия, не стоит их заглушать дебаунсом).
 *
 * # Scope MVP
 *
 * Типы шагов ограничены whitelist'ом `USER_ALLOWED_STEP_TYPES`
 * (`text | puzzle | endgame_drill`). Ограничение прокинуто в `StepEditor`
 * через prop `restrictToTypes` (FE-2, KS-1836). Backend это тоже валидирует.
 */

const AUTOSAVE_DEBOUNCE_MS = 500;

const USER_ALLOWED_STEP_TYPES: UserStepType[] = ['text', 'puzzle', 'endgame_drill'];

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Преобразует backend `UserLessonStepDto` в `StepFixture` (тот же шейп,
 * только client-side id). Редактор работает через `StepFixture`, ибо
 * делит код с админским `LessonEditorPage` (ADR §7 — не меняем админа).
 */
function stepDtoToFixture(dto: UserLessonStepDto): StepFixture {
  return {
    id: dto.id,
    order: dto.order,
    type: dto.type,
    payload: dto.payload,
  };
}

// ─── Page ──────────────────────────────────────────────────────────────

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' } // 403/404 / чужой owner
  | { kind: 'ready'; course: UserCourseDto; lessons: UserLessonDto[] };

export function UserCourseEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  // Initial load: course + lessons.
  useEffect(() => {
    if (!slug || !user) return;
    let cancelled = false;

    userCoursesApi
      .getBySlug(slug)
      .then((res) => {
        if (cancelled) return;
        if (res.course.ownerId !== user.id) {
          // Клиентский owner-guard (ADR-026 §2.6): чужой редактор не
          // должен даже мигать — сразу в finished-редирект.
          setState({ kind: 'forbidden' });
          return;
        }
        setState({
          kind: 'ready',
          course: res.course,
          lessons: res.lessons,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'forbidden' });
      });

    return () => {
      cancelled = true;
    };
  }, [slug, user]);

  if (!user) {
    // ProtectedRoute обычно не пускает unauth'а — но подстрахуемся для
    // стабильности типов и тестов.
    return <Navigate to="/login" replace />;
  }

  if (state.kind === 'loading') {
    return (
      <div className="loading" data-testid="user-course-editor-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (state.kind === 'forbidden') {
    // Редирект на /lessons с флагом «вы не автор» — LessonsPage или
    // toast-слой может его показать; в MVP просто redirect.
    return (
      <Navigate
        to="/lessons"
        replace
        state={{ toast: { kind: 'error', i18nKey: 'lessons.my.forbidden' } }}
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="error" data-testid="user-course-editor-error">
        {state.message}
      </div>
    );
  }

  const { course, lessons } = state;

  return (
    <CourseEditor
      course={course}
      lessons={lessons}
      onCourseChange={(next) =>
        setState({ kind: 'ready', course: next, lessons })
      }
      onLessonsChange={(next) =>
        setState({ kind: 'ready', course, lessons: next })
      }
      onDeleted={() => {
        navigate('/lessons', { replace: true });
      }}
    />
  );
}

// ─── CourseEditor (ready-state только) ───────────────────────────────

interface CourseEditorProps {
  course: UserCourseDto;
  lessons: UserLessonDto[];
  onCourseChange: (next: UserCourseDto) => void;
  onLessonsChange: (next: UserLessonDto[]) => void;
  onDeleted: () => void;
}

function CourseEditor({
  course,
  lessons,
  onCourseChange,
  onLessonsChange,
  onDeleted,
}: CourseEditorProps) {
  const { t } = useTranslation();
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  // ── Debounced PATCH для полей курса ────────────────────────────────
  const persistCourse = useCallback(
    (patch: Partial<UserCourseDto>) => {
      setSaveStatus('saving');
      userCoursesApi
        .update(course.id, {
          title: patch.title,
          description: patch.description,
          isPublic: patch.isPublic,
        })
        .then((updated) => {
          onCourseChange(updated);
          setSaveStatus('saved');
        })
        .catch(() => setSaveStatus('error'));
    },
    [course.id, onCourseChange],
  );

  const debouncedPersistCourse = useDebouncedCallback(
    persistCourse,
    AUTOSAVE_DEBOUNCE_MS,
  );

  const changeCourseField = <K extends keyof UserCourseDto>(
    key: K,
    value: UserCourseDto[K],
  ) => {
    const next = { ...course, [key]: value };
    onCourseChange(next);
    debouncedPersistCourse({ [key]: value } as Partial<UserCourseDto>);
  };

  // ── Lessons actions ────────────────────────────────────────────────
  const addLesson = async () => {
    const order = lessons.length;
    const created = await userCoursesApi.createLesson(course.id, {
      title: t('lessons.my.editor.defaultLessonTitle', 'New lesson'),
    });
    onLessonsChange([...lessons, { ...created, order }]);
  };

  const updateLessonTitle = (id: string, title: string) => {
    onLessonsChange(
      lessons.map((l) => (l.id === id ? { ...l, title } : l)),
    );
  };

  const debouncedPersistLesson = useDebouncedCallback(
    (lessonId: string, title: string) => {
      userCoursesApi.updateLesson(lessonId, { title }).catch(() => {
        setSaveStatus('error');
      });
    },
    AUTOSAVE_DEBOUNCE_MS,
  );

  const deleteLesson = async (id: string) => {
    // Оптимистично убираем из списка, потом PATCH. На 4xx возвращаем.
    const backup = lessons;
    onLessonsChange(lessons.filter((l) => l.id !== id));
    try {
      await userCoursesApi.deleteLesson(id);
    } catch {
      onLessonsChange(backup);
      setSaveStatus('error');
    }
  };

  const moveLesson = (id: string, dir: -1 | 1) => {
    const idx = lessons.findIndex((l) => l.id === id);
    if (idx === -1) return;
    const target = idx + dir;
    if (target < 0 || target >= lessons.length) return;
    const next = lessons.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    // Обновляем `order` локально; backend читает `order` из PATCH.
    const reordered = next.map((l, i) => ({ ...l, order: i }));
    onLessonsChange(reordered);
    // PATCH обоих — порядок важен в БД, а не только в памяти.
    userCoursesApi
      .updateLesson(reordered[idx].id, { order: reordered[idx].order })
      .catch(() => setSaveStatus('error'));
    userCoursesApi
      .updateLesson(reordered[target].id, {
        order: reordered[target].order,
      })
      .catch(() => setSaveStatus('error'));
  };

  const deleteCourse = async () => {
    if (
      !window.confirm(
        t('lessons.my.deleteConfirmBody', {
          title: course.title,
          defaultValue: 'Delete course "{{title}}"?',
        }),
      )
    )
      return;
    try {
      await userCoursesApi.delete(course.id);
      onDeleted();
    } catch {
      setSaveStatus('error');
    }
  };

  return (
    <div className="user-course-editor" data-testid="user-course-editor">
      <header className="user-course-editor__header">
        <h1>{t('lessons.my.editor.title', 'Edit course')}</h1>
        <div
          className="user-course-editor__save-status"
          data-testid="user-course-editor-save-status"
          aria-live="polite"
        >
          {saveStatus === 'saving' && t('lessons.my.editor.saving', 'Saving…')}
          {saveStatus === 'saved' && t('lessons.my.editor.saved', 'Saved')}
          {saveStatus === 'error' && t('lessons.my.editor.saveError', 'Save failed')}
        </div>
      </header>

      <section className="user-course-editor__form">
        <label>
          {t('lessons.my.createModal.fieldTitle', 'Title')}
          <input
            value={course.title}
            onChange={(e) => changeCourseField('title', e.target.value)}
            data-testid="user-course-title"
          />
        </label>
        <label>
          {t('lessons.my.createModal.fieldDescription', 'Description')}
          <textarea
            value={course.description ?? ''}
            onChange={(e) =>
              changeCourseField('description', e.target.value || null)
            }
            rows={3}
            data-testid="user-course-description"
          />
        </label>
        <label className="user-course-editor__visibility">
          <input
            type="checkbox"
            checked={course.isPublic}
            onChange={(e) => changeCourseField('isPublic', e.target.checked)}
            data-testid="user-course-is-public"
          />
          {course.isPublic
            ? t('lessons.my.editor.visibilityPublicHint', 'Visible to everyone')
            : t('lessons.my.editor.visibilityPrivateHint', 'Only you can see it')}
        </label>
      </section>

      <section
        className="user-course-editor__lessons"
        data-testid="user-course-editor-lessons"
      >
        <h2>
          {t('lessons.my.editor.lessonsTitle', 'Lessons')}{' '}
          <span className="user-course-editor__count">({lessons.length})</span>
        </h2>

        {lessons.length === 0 && (
          <p
            className="user-course-editor__empty"
            data-testid="user-course-editor-lessons-empty"
          >
            {t('lessons.my.editor.lessonsEmpty', 'No lessons yet')}
          </p>
        )}

        {lessons.map((lesson, i) => (
          <LessonEditorBlock
            key={lesson.id}
            lesson={lesson}
            courseId={course.id}
            canMoveUp={i > 0}
            canMoveDown={i < lessons.length - 1}
            onRename={(title) => {
              updateLessonTitle(lesson.id, title);
              debouncedPersistLesson(lesson.id, title);
            }}
            onDelete={() => deleteLesson(lesson.id)}
            onMoveUp={() => moveLesson(lesson.id, -1)}
            onMoveDown={() => moveLesson(lesson.id, 1)}
          />
        ))}

        <button
          type="button"
          className="user-course-editor__add-lesson"
          onClick={addLesson}
          data-testid="user-course-editor-add-lesson"
        >
          + {t('lessons.my.editor.addLesson', 'Add lesson')}
        </button>
      </section>

      <footer className="user-course-editor__footer">
        <button
          type="button"
          className="user-course-editor__delete"
          onClick={deleteCourse}
          data-testid="user-course-editor-delete"
        >
          {t('lessons.my.delete', 'Delete course')}
        </button>
      </footer>
    </div>
  );
}

// ─── LessonEditorBlock — один урок с подгрузкой шагов ────────────────

interface LessonEditorBlockProps {
  lesson: UserLessonDto;
  courseId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function LessonEditorBlock({
  lesson,
  canMoveUp,
  canMoveDown,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: LessonEditorBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [stepsState, setStepsState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'ready'; steps: StepFixture[] }
  >({ kind: 'idle' });

  // При раскрытии — догружаем шаги.
  useEffect(() => {
    if (!expanded) return;
    if (stepsState.kind === 'ready' || stepsState.kind === 'loading') return;
    setStepsState({ kind: 'loading' });
    userCoursesApi
      .getLesson(lesson.id)
      .then((res: UserLessonWithStepsResponse) => {
        setStepsState({
          kind: 'ready',
          steps: res.steps.map(stepDtoToFixture),
        });
      })
      .catch(() => setStepsState({ kind: 'error' }));
  }, [expanded, lesson.id, stepsState.kind]);

  const debouncedPersistStep = useDebouncedCallback(
    (stepId: string, payload: StepFixture['payload']) => {
      userCoursesApi.updateStep(stepId, { payload }).catch(() => {
        /* no-op: статус ошибки агрегирует родитель */
      });
    },
    AUTOSAVE_DEBOUNCE_MS,
  );

  const setSteps = (fn: (cur: StepFixture[]) => StepFixture[]) => {
    setStepsState((prev) =>
      prev.kind === 'ready' ? { kind: 'ready', steps: fn(prev.steps) } : prev,
    );
  };

  const addStep = async () => {
    const nextOrder =
      stepsState.kind === 'ready' ? stepsState.steps.length : 0;
    const type: UserStepType = 'text';
    try {
      const created = await userCoursesApi.createStep(lesson.id, {
        type,
        payload: emptyStepPayload(type),
      });
      setSteps((cur) => [...cur, { ...stepDtoToFixture(created), order: nextOrder }]);
    } catch {
      /* ignore; будем уметь показывать в родителе позже */
    }
  };

  const updateStep = (next: StepFixture) => {
    setSteps((cur) => cur.map((s) => (s.id === next.id ? next : s)));
    debouncedPersistStep(next.id, next.payload);
  };

  const removeStep = async (id: string) => {
    setSteps((cur) => cur.filter((s) => s.id !== id));
    try {
      await userCoursesApi.deleteStep(id);
    } catch {
      // Тяжелее всего — откатить удаление. На MVP делаем best-effort.
    }
  };

  const moveStep = (id: string, dir: -1 | 1) => {
    if (stepsState.kind !== 'ready') return;
    const steps = stepsState.steps;
    const idx = steps.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    const withOrder = next.map((s, i) => ({ ...s, order: i }));
    setSteps(() => withOrder);
    userCoursesApi
      .reorderSteps(lesson.id, { ids: withOrder.map((s) => s.id) })
      .catch(() => {
        /* ignore MVP */
      });
  };

  return (
    <details
      className="user-course-editor__lesson"
      open={expanded}
      data-testid={`user-course-editor-lesson-${lesson.id}`}
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
    >
      <summary className="user-course-editor__lesson-summary">
        <input
          value={lesson.title}
          onChange={(e) => onRename(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          data-testid={`user-course-editor-lesson-title-${lesson.id}`}
        />
        <div className="user-course-editor__lesson-actions">
          {canMoveUp && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMoveUp();
              }}
              data-testid={`user-course-editor-lesson-up-${lesson.id}`}
              title={t('editor.moveUp', 'Move up')}
            >
              ↑
            </button>
          )}
          {canMoveDown && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMoveDown();
              }}
              data-testid={`user-course-editor-lesson-down-${lesson.id}`}
              title={t('editor.moveDown', 'Move down')}
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            data-testid={`user-course-editor-lesson-delete-${lesson.id}`}
          >
            {t('editor.remove', 'Remove')}
          </button>
        </div>
      </summary>

      <div className="user-course-editor__lesson-body">
        {stepsState.kind === 'loading' && (
          <div className="loading">{t('common.loading')}</div>
        )}
        {stepsState.kind === 'error' && (
          <div className="error">
            {t('lessons.my.editor.loadStepsError', 'Failed to load steps')}
          </div>
        )}
        {stepsState.kind === 'ready' && (
          <>
            {stepsState.steps.map((step) => (
              <StepEditor
                key={step.id}
                step={step}
                onChange={updateStep}
                onRemove={() => removeStep(step.id)}
                onMoveUp={() => moveStep(step.id, -1)}
                onMoveDown={() => moveStep(step.id, 1)}
                restrictToTypes={USER_ALLOWED_STEP_TYPES}
              />
            ))}
            <button
              type="button"
              onClick={addStep}
              data-testid={`user-course-editor-add-step-${lesson.id}`}
            >
              + {t('lessons.my.editor.addStep', 'Add step')}
            </button>
          </>
        )}
      </div>
    </details>
  );
}
