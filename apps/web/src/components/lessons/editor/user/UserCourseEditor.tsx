import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  StepPayload,
  UserCourseDto,
  UserLessonWithStepsResponse,
  UserStepType,
} from '@kingside/shared';

import { userCoursesApi } from '../../../../api/userCoursesApi';
import { useAuth } from '../../../../context/AuthContext';
import { useAutoSave } from '../../../../hooks/useAutoSave';
import { useUserCourseState } from '../../../../hooks/useUserCourseState';
import { emptyStepPayload } from '../../../../types/editor';
import { AddLessonEmptyState } from './AddLessonEmptyState';
import { CourseOutline } from './CourseOutline';
import { DeleteCourseDialog } from './DeleteCourseDialog';
import { LessonOverview } from './LessonOverview';
import { UserCourseHeader } from './UserCourseHeader';

/**
 * `UserCourseEditor` — root-контейнер редактора пользовательского курса
 * (KS-1848 §3.2/§3.3, KS-1857 / FE-R9). Собирает всё, что было сделано
 * в FE-R2…R7/R10:
 *
 *  - Загрузка курса через `userCoursesApi.getBySlug` + owner-guard
 *  - `useUserCourseState` — reducer state для courses/lessons/steps
 *  - `useAutoSave` — debounced PATCH метаданных курса
 *  - `<UserCourseHeader>` наверху (title inline + save pill + publish +
 *    owner-menu)
 *  - Desktop layout: CSS-grid 320px / 1fr — слева `<CourseOutline>`,
 *    справа `<LessonOverview>` или `<AddLessonEmptyState>` если курс пуст
 *  - Mobile layout: tabs «Outline / Editor» (у грида auto-collapse
 *    через CSS L-R2; здесь — runtime switch для jsdom-тестов)
 *  - URL-routing: активный урок в query `?lesson=:id`; если параметр не
 *    задан — берётся первый урок
 *  - `<DeleteCourseDialog>` — открывается из `<OwnerActionsMenu>`
 *
 * Публичный маршрут — `/lessons/my/:slug/edit` за `<ProtectedRoute>`
 * (заменяет старый `UserCourseEditorPage`, маршрут сохранён).
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'forbidden' } // 404/403/чужой owner
  | { kind: 'ready' };

type MobileTab = 'outline' | 'editor';

const AUTOSAVE_DEBOUNCE_MS = 500;

export function UserCourseEditor() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('outline');
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedLessonIds, setExpandedLessonIds] = useState<Set<string>>(
    () => new Set(),
  );

  const { state, actions } = useUserCourseState();

  // ── Initial load ───────────────────────────────────────────────────
  useEffect(() => {
    if (!slug || !user) return;
    let cancelled = false;
    setLoad({ kind: 'loading' });
    userCoursesApi
      .getBySlug(slug)
      .then((res) => {
        if (cancelled) return;
        if (res.course.ownerId !== user.id) {
          setLoad({ kind: 'forbidden' });
          return;
        }
        actions.loadCourse(res.course, res.lessons);
        setLoad({ kind: 'ready' });
      })
      .catch(() => {
        if (cancelled) return;
        setLoad({ kind: 'forbidden' });
      });
    return () => {
      cancelled = true;
    };
    // Intentionally avoid `actions` — useCallback-stable (reducer-based).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, user]);

  // ── Active lesson (из ?lesson=:id или первый по order) ────────────
  const activeLessonId = useMemo(() => {
    if (state.lessons.length === 0) return null;
    const fromQuery = searchParams.get('lesson');
    if (fromQuery && state.lessons.some((l) => l.id === fromQuery)) {
      return fromQuery;
    }
    return state.lessons[0].id;
  }, [searchParams, state.lessons]);

  const setActiveLesson = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('lesson', id);
          return next;
        },
        { replace: true },
      );
      setMobileTab('editor');
    },
    [setSearchParams],
  );

  // ── Lazy-load шагов активного урока ───────────────────────────────
  // Guard через ref, чтобы не повторять запрос при каждой смене state —
  // иначе ре-рендеры от `actions.setSteps` могут перезапускать effect
  // и порождать цепочку (особенно на slow jsdom / strict-mode).
  const loadedStepsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeLessonId) return;
    if (loadedStepsRef.current.has(activeLessonId)) return;
    loadedStepsRef.current.add(activeLessonId);
    let cancelled = false;
    userCoursesApi
      .getLesson(activeLessonId)
      .then((res: UserLessonWithStepsResponse) => {
        if (cancelled) return;
        actions.setSteps(activeLessonId, res.steps);
      })
      .catch(() => {
        /* оставляем кеш пустым — UI покажет пустое состояние */
        loadedStepsRef.current.delete(activeLessonId);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLessonId]);

  // ── Course meta autosave ──────────────────────────────────────────
  const saveCourse = useCallback(
    async (patch: Partial<UserCourseDto>) => {
      if (!state.course) return;
      await userCoursesApi.update(state.course.id, {
        title: patch.title,
        description: patch.description,
        isPublic: patch.isPublic,
      });
    },
    [state.course],
  );
  const courseSave = useAutoSave({
    saveFn: saveCourse,
    delayMs: AUTOSAVE_DEBOUNCE_MS,
  });

  // ── Lesson actions ────────────────────────────────────────────────
  const addLesson = async () => {
    if (!state.course) return;
    const created = await userCoursesApi.createLesson(state.course.id, {
      title: t('lessons.my.editor.defaultLessonTitle', 'New lesson'),
    });
    actions.addLesson(created);
    setActiveLesson(created.id);
  };

  const deleteLesson = async (id: string) => {
    actions.deleteLesson(id);
    try {
      await userCoursesApi.deleteLesson(id);
    } catch {
      /* best-effort: если падает — на следующем refresh восстановится */
    }
    // Если удалили активный — переключаемся на первый оставшийся.
    if (activeLessonId === id && state.lessons.length > 1) {
      const others = state.lessons.filter((l) => l.id !== id);
      if (others[0]) setActiveLesson(others[0].id);
    }
  };

  const patchLesson = useCallback(
    (lessonId: string, patch: { title?: string; estMinutes?: number | null }) => {
      actions.updateLesson(lessonId, patch);
      userCoursesApi.updateLesson(lessonId, patch).catch(() => {
        /* ignore — обычно автосейв; глобальный статус показывает ошибку */
      });
    },
    [actions],
  );

  const moveLesson = (lessonId: string, direction: -1 | 1) => {
    const idx = state.lessons.findIndex((l) => l.id === lessonId);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= state.lessons.length) return;
    const orderedIds = state.lessons.map((l) => l.id);
    [orderedIds[idx], orderedIds[target]] = [
      orderedIds[target],
      orderedIds[idx],
    ];
    actions.reorderLessons(orderedIds);
    // PATCH обоих переставленных lesson'ов.
    userCoursesApi
      .updateLesson(orderedIds[idx], { order: idx })
      .catch(() => {});
    userCoursesApi
      .updateLesson(orderedIds[target], { order: target })
      .catch(() => {});
  };

  // ── Step actions ──────────────────────────────────────────────────
  const addStep = async (lessonId: string, type: UserStepType) => {
    const payload = emptyStepPayload(type) as StepPayload;
    const created = await userCoursesApi.createStep(lessonId, {
      type,
      payload,
    });
    actions.addStep(lessonId, created);
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      next.add(created.id);
      return next;
    });
  };

  const deleteStep = async (lessonId: string, stepId: string) => {
    actions.deleteStep(lessonId, stepId);
    userCoursesApi.deleteStep(stepId).catch(() => {});
  };

  const duplicateStep = async (lessonId: string, stepId: string) => {
    const src = state.stepsByLesson[lessonId]?.find((s) => s.id === stepId);
    if (!src) return;
    const created = await userCoursesApi.createStep(lessonId, {
      type: src.type,
      payload: src.payload,
    });
    actions.addStep(lessonId, created, stepId);
  };

  const patchStepPayload = (
    lessonId: string,
    stepId: string,
    payload: StepPayload,
  ) => {
    actions.updateStep(lessonId, stepId, { payload });
    userCoursesApi.updateStep(stepId, { payload }).catch(() => {});
  };

  const moveStep = (lessonId: string, stepId: string, direction: -1 | 1) => {
    const steps = state.stepsByLesson[lessonId] ?? [];
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= steps.length) return;
    const orderedIds = steps.map((s) => s.id);
    [orderedIds[idx], orderedIds[target]] = [
      orderedIds[target],
      orderedIds[idx],
    ];
    actions.reorderSteps(lessonId, orderedIds);
    userCoursesApi.reorderSteps(lessonId, { ids: orderedIds }).catch(() => {});
  };

  const toggleStepExpand = (stepId: string) => {
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const toggleLessonOutlineExpand = (lessonId: string) => {
    setExpandedLessonIds((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId);
      else next.add(lessonId);
      // При раскрытии — триггерим lazy-load шагов (useEffect сделает это
      // только для activeLessonId, поэтому руками).
      if (!prev.has(lessonId) && !state.stepsByLesson[lessonId]) {
        userCoursesApi
          .getLesson(lessonId)
          .then((res) => actions.setSteps(lessonId, res.steps))
          .catch(() => {});
      }
      return next;
    });
  };

  // ── Course actions (header) ───────────────────────────────────────
  const onCourseTitleChange = (next: string) => {
    actions.updateCourseMeta({ title: next });
    courseSave.save({ title: next });
  };

  const onPublicChange = (next: boolean) => {
    actions.updateCourseMeta({ isPublic: next });
    courseSave.save({ isPublic: next });
  };

  const onCopyLink = () => {
    if (!state.course) return;
    const url = `${window.location.origin}/lessons/my/${state.course.slug}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url);
    }
  };

  const onView = () => {
    if (!state.course) return;
    navigate(`/lessons/my/${state.course.slug}`);
  };

  const onDeleteCourse = async () => {
    if (!state.course) return;
    setDeleteOpen(false);
    try {
      await userCoursesApi.delete(state.course.id);
      navigate('/lessons', { replace: true });
    } catch {
      /* если упал — модалка уже закрылась; можно показать toast */
    }
  };

  // ── Early returns ─────────────────────────────────────────────────
  if (!user) return <Navigate to="/login" replace />;
  if (load.kind === 'loading') {
    return (
      <div className="loading" data-testid="user-course-editor-loading">
        {t('common.loading')}
      </div>
    );
  }
  if (load.kind === 'forbidden' || !state.course) {
    return (
      <Navigate
        to="/lessons"
        replace
        state={{ toast: { kind: 'error', i18nKey: 'lessons.my.forbidden' } }}
      />
    );
  }

  const activeLesson = state.lessons.find((l) => l.id === activeLessonId);
  const activeSteps = activeLessonId
    ? state.stepsByLesson[activeLessonId] ?? []
    : [];

  return (
    <div className="user-course-editor" data-testid="user-course-editor">
      <UserCourseHeader
        title={state.course.title}
        isPublic={state.course.isPublic}
        saveStatus={courseSave.status}
        lastSavedAt={courseSave.lastSavedAt}
        onTitleChange={onCourseTitleChange}
        onRetrySave={courseSave.retry}
        onPublicChange={onPublicChange}
        onView={onView}
        onCopyLink={onCopyLink}
        onDelete={() => setDeleteOpen(true)}
      />

      {/* Mobile-tabs; на desktop CSS (L-R2) скроет их и покажет split-pane
          одновременно. Здесь для jsdom-совместимости оба варианта присутствуют
          в DOM, CSS решает какой видимый. */}
      <div
        className="user-course-editor__mobile-tabs"
        data-testid="user-course-editor-mobile-tabs"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'outline'}
          onClick={() => setMobileTab('outline')}
          data-testid="user-course-editor-tab-outline"
        >
          {t('lessons.my.editor.lessonsTitle', 'Lessons')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'editor'}
          onClick={() => setMobileTab('editor')}
          data-testid="user-course-editor-tab-editor"
        >
          {t('lessons.my.editor.title', 'Editor')}
        </button>
      </div>

      <div
        className={`user-course-editor__body user-course-editor__body--${mobileTab}`}
        data-testid="user-course-editor-body"
      >
        <div
          className={`user-course-editor__outline${mobileTab === 'outline' ? '' : ' user-course-editor__outline--mobile-hidden'}`}
          data-testid="user-course-editor-outline-pane"
        >
          <CourseOutline
            lessons={state.lessons}
            activeLessonId={activeLessonId}
            stepsByLesson={state.stepsByLesson}
            expandedLessonIds={expandedLessonIds}
            onSelectLesson={setActiveLesson}
            onToggleLessonExpand={toggleLessonOutlineExpand}
            onAddLesson={addLesson}
            onSelectStep={(lessonId, stepId) => {
              setActiveLesson(lessonId);
              setExpandedStepIds((prev) => {
                const next = new Set(prev);
                next.add(stepId);
                return next;
              });
            }}
          />
        </div>

        <div
          className={`user-course-editor__main${mobileTab === 'editor' ? '' : ' user-course-editor__main--mobile-hidden'}`}
          data-testid="user-course-editor-main-pane"
        >
          {!activeLesson ? (
            <AddLessonEmptyState onAdd={addLesson} />
          ) : (
            <LessonOverview
              lesson={activeLesson}
              steps={activeSteps}
              expandedStepIds={expandedStepIds}
              onTitleChange={(next) => patchLesson(activeLesson.id, { title: next })}
              onEstMinutesChange={(next) =>
                patchLesson(activeLesson.id, { estMinutes: next })
              }
              onDeleteLesson={() => deleteLesson(activeLesson.id)}
              onToggleStepExpand={toggleStepExpand}
              onStepPayloadChange={(stepId, payload) =>
                patchStepPayload(activeLesson.id, stepId, payload)
              }
              onDeleteStep={(stepId) => deleteStep(activeLesson.id, stepId)}
              onDuplicateStep={(stepId) =>
                duplicateStep(activeLesson.id, stepId)
              }
              onAddStep={(type) => addStep(activeLesson.id, type)}
              onMoveStep={(stepId, dir) =>
                moveStep(activeLesson.id, stepId, dir)
              }
            />
          )}
        </div>
      </div>

      <DeleteCourseDialog
        open={deleteOpen}
        courseTitle={state.course.title}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={onDeleteCourse}
      />
    </div>
  );
}
