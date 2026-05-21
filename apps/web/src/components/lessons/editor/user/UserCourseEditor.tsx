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

import { lessonsApi } from '../../../../api/lessonsApi';
import { useAuth } from '../../../../context/AuthContext';
import { useAutoSave } from '../../../../hooks/useAutoSave';
import { useUserCourseState } from '../../../../hooks/useUserCourseState';
import { emptyStepPayload } from '../../../../types/editor';
import { AddLessonEmptyState } from './AddLessonEmptyState';
import { CourseOutline } from './CourseOutline';
import { DeleteCourseDialog } from './DeleteCourseDialog';
import { LessonOverview } from './LessonOverview';
import { UserCourseHeader } from './UserCourseHeader';
import {
  buildPublicCourseUrl,
  pickNextActiveLessonId,
  resolveActiveLessonId,
  resolveOwnerGuard,
  swapAt,
} from './userCourseEditorLogic';

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

/**
 * KS-2596: backend (NestJS ValidationPipe / class-validator) возвращает
 * для невалидного quiz-payload сырые строки вида:
 *   `payload.questions.0.correctOptionIds should not be empty`
 *   `payload.questions.0.options must contain at least 2 elements`
 *
 * Эти сообщения не локализованы, не дружелюбны для автора и в RU выглядели
 * как «английский хвост» в красной плашке. Здесь распознаём типовые quiz-
 * валидации и перекрываем человекочитаемым текстом из i18n
 * (`lessons.my.editor.quiz.validation.*` — те же ключи, что подсвечиваются
 * inline в QuizStepEditor). Если паттерн не распознан — отдаём raw
 * как было до KS-2596 (back-compat для не-quiz ошибок и неизвестных форматов).
 */
function localizeQuizSaveError(
  t: (key: string, defaultValue?: string) => string,
  raw: string,
): string {
  if (/correctOptionIds.*should not be empty/i.test(raw)) {
    return t(
      'lessons.my.editor.quiz.validation.noCorrect',
      'Mark at least one correct option',
    );
  }
  if (/options.*(must contain|at least 2)/i.test(raw)) {
    return t(
      'lessons.my.editor.quiz.validation.minOptions',
      'At least 2 options required',
    );
  }
  return raw;
}

/**
 * KS-2696. Pre-validation шага перед отправкой PATCH /lessons/steps/:id.
 *
 * Цель — не дёргать сервер на очевидно неполном payload'е, чтобы
 * backend не возвращал 400 на каждый keystroke и красный banner-toast
 * не мерцал. Сейчас покрывает один реальный сценарий жалобы пользователя:
 *  - puzzle-шаг в режиме filter с пустым `selection.themes`. Backend
 *    ругается `payload.selection.themes should not be empty` (см.
 *    скриншот KS-2696). Все остальные поля (rating/limit) при пустых
 *    themes пропускаем, ждём пока юзер заполнит хотя бы одну тему.
 *
 * Возвращает `true` если PATCH можно слать. Любой неизвестный тип
 * шага считается валидным — лучше отдать backend'у и показать его
 * сообщение, чем глушить запрос на FE по ошибке.
 */
function isStepPayloadAutoSavable(payload: StepPayload): boolean {
  if (payload.type === 'puzzle') {
    if (
      payload.selection.mode === 'filter' &&
      payload.selection.themes.length === 0
    ) {
      return false;
    }
  }
  // KS-3181 (ADR-072 §7 F1): шаг «Партия» отправляем только когда
  // payload реально пригоден для backend'а:
  //  - sourceType='pgn' без непустого `pgn` ⇒ backend ответит 400
  //    «PGN is required», UI заставит автора заполнить поле раньше.
  //    Невалидность PGN (chess.js loadPgn → throw) ловится в самом
  //    редакторе как inline-ошибка; здесь не дублируем проверку.
  //  - sourceType='workshop_analysis' без `analysisId` ⇒ backend
  //    ответит 400 «analysisId is required». До выбора анализа PATCH'и
  //    не шлём.
  if (payload.type === 'game') {
    if (payload.sourceType === 'pgn' && !(payload.pgn ?? '').trim()) {
      return false;
    }
    if (
      payload.sourceType === 'workshop_analysis' &&
      !payload.analysisId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * KS-2696. Debounce-окно autosave PATCH /lessons/steps/:id.
 * 600ms — пользователь успевает добить число/слово до отправки;
 * меньше — bursty PATCH'ей при наборе цифр; больше — заметная
 * задержка save-pill'а.
 */
const STEP_AUTOSAVE_DEBOUNCE_MS = 600;

export function UserCourseEditor() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('outline');
  /**
   * KS-1912: видимая ошибка автосейва шага. До этого fix'а
   * `userCoursesApi.updateStep().catch(() => {})` глотал любую
   * 4xx — пользователь не видел что сохранение упало (например,
   * 400 «customPuzzles must contain at least 1 element»). Теперь
   * последняя ошибка показывается в alert-bar над списком шагов
   * и не разрушает страницу.
   */
  const [stepSaveError, setStepSaveError] = useState<string | null>(null);
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
    lessonsApi
      .getUserCourse(slug)
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
  const activeLessonId = useMemo(
    () =>
      resolveActiveLessonId({
        lessonsQuery: searchParams.get('lesson'),
        lessons: state.lessons,
      }),
    [searchParams, state.lessons],
  );

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
    lessonsApi
      .getUserLesson(activeLessonId)
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
      await lessonsApi.updateCourse(state.course.id, {
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
    const created = await lessonsApi.createLesson(state.course.id, {
      title: t('lessons.my.editor.defaultLessonTitle', 'New lesson'),
    });
    actions.addLesson(created);
    setActiveLesson(created.id);
  };

  const deleteLesson = async (id: string) => {
    // Решаем активного ДО мутации state, чтобы pickNextActiveLessonId
    // видел исходный порядок уроков.
    const nextActive =
      activeLessonId === id
        ? pickNextActiveLessonId(state.lessons, id)
        : null;
    actions.deleteLesson(id);
    try {
      await lessonsApi.deleteLesson(id);
    } catch {
      /* best-effort: если падает — на следующем refresh восстановится */
    }
    if (nextActive) setActiveLesson(nextActive);
  };

  const patchLesson = useCallback(
    (lessonId: string, patch: { title?: string; estMinutes?: number | null }) => {
      actions.updateLesson(lessonId, patch);
      lessonsApi.updateLesson(lessonId, patch).catch(() => {
        /* ignore — обычно автосейв; глобальный статус показывает ошибку */
      });
    },
    [actions],
  );

  // KS-2034: legacy `moveLesson(lessonId, direction)` удалён —
  // перестановка уроков делается только через DnD (`onLessonsDndEnd`)
  // ниже. Если потребуется снова кнопочный «вверх/вниз», восстановить
  // из истории git.

  /**
   * FE-R13: произвольная перестановка уроков из DnD (`@dnd-kit`).
   * Применяет новый порядок оптимистично + PATCH каждого урока с
   * новым `order`. Backend не имеет batch-reorder для уроков (есть
   * только для шагов через `/user-lessons/:id/steps/reorder`);
   * параллельные PATCH приемлемы — не более десятков уроков на курс.
   */
  const reorderLessonsByIds = useCallback(
    (orderedIds: string[]) => {
      actions.reorderLessons(orderedIds);
      orderedIds.forEach((id, order) => {
        lessonsApi.updateLesson(id, { order }).catch(() => {});
      });
    },
    [actions],
  );

  /**
   * FE-R13: произвольная перестановка шагов активного урока из DnD.
   * `userCoursesApi.reorderSteps` — батч-эндпоинт (BE-3 ADR §2.5),
   * одна транзакция на сервере.
   */
  const reorderStepsByIds = useCallback(
    (lessonId: string, orderedIds: string[]) => {
      actions.reorderSteps(lessonId, orderedIds);
      lessonsApi
        .reorderSteps(lessonId, { ids: orderedIds })
        .catch(() => {});
    },
    [actions],
  );

  // ── Step actions ──────────────────────────────────────────────────
  const addStep = async (lessonId: string, type: UserStepType) => {
    // KS-3184: до этого тикета `createStep` бросал на 4xx (например 400
    // от backend KS-3180 на game-шаг с пустым PGN), и поскольку
    // `addStep` НЕ ловил исключение, клик «Добавить первый шаг» молча
    // терялся в promise rejection. Сейчас:
    //  1) дефолт game-payload содержит placeholder PGN `*` (см.
    //     `emptyStepPayload`) — backend проходит, шаг создаётся;
    //  2) try/catch ловит любые будущие ошибки и показывает их
    //     через `stepSaveError` (тот же floating-toast, что и у
    //     `updateStepPayload`). Без этого даже после фикса любая
    //     новая регрессия в createStep была бы невидимой.
    const payload = emptyStepPayload(type) as StepPayload;
    let created;
    try {
      created = await lessonsApi.createStep(lessonId, {
        type,
        payload,
      });
    } catch (err: unknown) {
      const rawMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : t('lessons.my.editor.addStepError', 'Could not add step');
      const message = localizeQuizSaveError(t, rawMessage);
      setStepSaveError(message);
      return;
    }
    actions.addStep(lessonId, created);
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      next.add(created.id);
      return next;
    });
  };

  const deleteStep = async (lessonId: string, stepId: string) => {
    actions.deleteStep(lessonId, stepId);
    lessonsApi.deleteStep(stepId).catch(() => {});
  };

  const duplicateStep = async (lessonId: string, stepId: string) => {
    const src = state.stepsByLesson[lessonId]?.find((s) => s.id === stepId);
    if (!src) return;
    const created = await lessonsApi.createStep(lessonId, {
      type: src.type,
      payload: src.payload,
    });
    actions.addStep(lessonId, created, stepId);
  };

  /**
   * KS-2696: debounced таймеры PATCH'ей по stepId. Каждый keystroke
   * планирует таймер; следующий keystroke сбрасывает старый. Это
   * убирает burst-PATCH'и при наборе цифр в number-полях (Rating
   * min/max/Limit/Min solved) — основная причина layout-shift'а
   * по жалобе пользователя.
   *
   * Локальное состояние (state в reducer'е) обновляем сразу — UX
   * остаётся отзывчивым.
   */
  const patchTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Cleanup всех pending таймеров при unmount, чтобы не стрельнуло
  // PATCH'ом после ухода со страницы.
  useEffect(() => {
    const timers = patchTimersRef.current;
    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  const patchStepPayload = (
    lessonId: string,
    stepId: string,
    payload: StepPayload,
  ) => {
    actions.updateStep(lessonId, stepId, { payload });

    // KS-2696: pre-validation. Если payload очевидно неполный
    // (puzzle-filter без themes — частый сценарий: автор сначала
    // выставил mode=filter, начал крутить rating, темы добить
    // позже), не шлём PATCH вообще. Без этого backend на каждый
    // keystroke возвращает 400 → красный banner мигает → форма
    // прыгает. Inline-валидация в `PuzzleFields` (data-invalid
    // на пустых themes) уже подсвечивает поле — backend нам не нужен.
    if (!isStepPayloadAutoSavable(payload)) {
      // Сбрасываем pending таймер: если был запланирован старый
      // (валидный) PATCH — он теперь устарел.
      const pending = patchTimersRef.current.get(stepId);
      if (pending) {
        clearTimeout(pending);
        patchTimersRef.current.delete(stepId);
      }
      // Чистим прошлую ошибку: повторный ввод после неудачного
      // PATCH'а не должен оставлять «висящий» banner-toast.
      setStepSaveError(null);
      return;
    }

    // Сбрасываем старый pending PATCH для этого шага и планируем
    // новый. Это и есть debounce-окно (STEP_AUTOSAVE_DEBOUNCE_MS).
    const existing = patchTimersRef.current.get(stepId);
    if (existing) clearTimeout(existing);

    const timerId = setTimeout(() => {
      patchTimersRef.current.delete(stepId);
      setStepSaveError(null);
      lessonsApi
        .updateStepPayload(stepId, { payload })
        .catch((err: unknown) => {
          // KS-1912: показываем ошибку, не редиректим. До фикса
          // promise-rejection здесь приводил к «пустой странице» через
          // глобальный fail-path; теперь UI остаётся в редакторе и
          // отображает toast с возможностью dismiss (KS-2696 — было
          // alert-bar в потоке, что вызывало layout-shift).
          const rawMessage =
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : t('lessons.my.editor.saveError', 'Could not save step');
          // KS-2596: backend (NestJS ValidationPipe) возвращает сырое
          // class-validator сообщение. Для quiz-валидаций перекрываем
          // человекочитаемым текстом из i18n. Если паттерн не распознан
          // — показываем raw.
          const message = localizeQuizSaveError(t, rawMessage);
          setStepSaveError(message);
        });
    }, STEP_AUTOSAVE_DEBOUNCE_MS);
    patchTimersRef.current.set(stepId, timerId);
  };

  const moveStep = (lessonId: string, stepId: string, direction: -1 | 1) => {
    const steps = state.stepsByLesson[lessonId] ?? [];
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= steps.length) return;
    const orderedIds = swapAt(steps.map((s) => s.id), idx, target);
    actions.reorderSteps(lessonId, orderedIds);
    lessonsApi.reorderSteps(lessonId, { ids: orderedIds }).catch(() => {});
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
        lessonsApi
          .getUserLesson(lessonId)
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
    const url = buildPublicCourseUrl(window.location.origin, state.course.slug);
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
      await lessonsApi.deleteCourse(state.course.id);
      navigate('/lessons', { replace: true });
    } catch {
      /* если упал — модалка уже закрылась; можно показать toast */
    }
  };

  // ── Early returns ─────────────────────────────────────────────────
  const guardVerdict = resolveOwnerGuard({
    userId: user?.id ?? null,
    course: state.course,
    loadError: load.kind === 'forbidden',
  });
  if (guardVerdict === 'unauthorized') return <Navigate to="/login" replace />;
  if (guardVerdict === 'forbidden') {
    return (
      <Navigate
        to="/lessons"
        replace
        state={{ toast: { kind: 'error', i18nKey: 'lessons.my.forbidden' } }}
      />
    );
  }
  if (load.kind === 'loading' || !state.course) {
    return (
      <div className="loading" data-testid="user-course-editor-loading">
        {t('common.loading')}
      </div>
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

      {/* KS-2696: ошибка автосейва теперь — floating toast снизу страницы
          (`position:fixed`), а не алерт в потоке формы. До этого тикета
          появление/исчезновение баннера на каждый failed PATCH (а они
          летели на каждый keystroke в number-полях, см. KS-2696 жалобу)
          двигало форму вертикально. Toast не влияет на flow → форма не
          прыгает. data-testid сохранён для backward-compat с e2e/unit
          тестами KS-1912 / KS-2596. */}
      {stepSaveError && (
        <div
          className="user-course-editor__save-error"
          data-testid="user-course-editor-step-save-error"
          role="alert"
        >
          <span>
            {t(
              'lessons.my.editor.stepSaveError',
              'Could not save changes — {{message}}',
              { message: stepSaveError },
            )}
          </span>
          <button
            type="button"
            onClick={() => setStepSaveError(null)}
            data-testid="user-course-editor-step-save-error-dismiss"
            aria-label={t('common.dismiss', 'Dismiss')}
          >
            ✕
          </button>
        </div>
      )}

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
            onReorderLessons={reorderLessonsByIds}
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
              onReorderSteps={(orderedIds) =>
                reorderStepsByIds(activeLesson.id, orderedIds)
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
