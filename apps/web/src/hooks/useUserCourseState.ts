import { useCallback, useReducer } from 'react';
import type {
  UserCourseDto,
  UserLessonDto,
  UserLessonStepDto,
} from '@kingside/shared';

import type { AutoSaveStatus } from './useAutoSave';

/**
 * `useUserCourseState` — редуктор стейта редактора user-курса
 * (KS-1848 §4, KS-1858 / FE-R10).
 *
 * State:
 *  - `course` — мета курса (title/description/isPublic/counters)
 *  - `lessons` — список уроков (сортировка по `order`)
 *  - `stepsByLesson` — кеш шагов по id урока (подгружаются лениво)
 *  - `saveStatus` — глобальный статус автосохранения (для `<SaveStatusPill>`)
 *
 * Редуктор — чистая функция, тестируется независимо. Хук ниже
 * оборачивает его в React-API и экспонирует диспатчеры действий
 * одним `actions`-объектом (это удобнее «голого» `dispatch`, который
 * пришлось бы импортировать из шапки).
 *
 * Примечание: API-вызовы (POST/PATCH/DELETE) НЕ делаются внутри
 * хука — это специально. Страница редактора сама решает когда и
 * что отправлять (например — через `useAutoSave` из FE-R2), а
 * оптимистичные изменения и откаты на ошибках сидят в actions:
 * `*Start`/`*Success`/`*Failure` pair'ы позволяют компоненту
 * выразить такой поток через стейт-машину без лишней связанности
 * с конкретными API-функциями.
 */

// ─── State ──────────────────────────────────────────────────────────

export interface UserCourseState {
  course: UserCourseDto | null;
  lessons: UserLessonDto[];
  stepsByLesson: Record<string, UserLessonStepDto[]>;
  saveStatus: AutoSaveStatus;
}

export const initialUserCourseState: UserCourseState = {
  course: null,
  lessons: [],
  stepsByLesson: {},
  saveStatus: 'idle',
};

// ─── Actions ────────────────────────────────────────────────────────

export type UserCourseAction =
  /** Полная замена состояния при первоначальной загрузке. */
  | {
      type: 'loadCourse';
      course: UserCourseDto;
      lessons: UserLessonDto[];
    }
  /** Патч метаданных курса (title/description/isPublic и т.п.). */
  | { type: 'updateCourseMeta'; patch: Partial<UserCourseDto> }
  /** Добавить урок в конец списка (или после `afterLessonId`). */
  | {
      type: 'addLesson';
      lesson: UserLessonDto;
      afterLessonId?: string | null;
    }
  /** Патч урока (title / estMinutes / order / stepCount). */
  | { type: 'updateLesson'; id: string; patch: Partial<UserLessonDto> }
  /** Удалить урок вместе с кешем шагов. */
  | { type: 'deleteLesson'; id: string }
  /** Пересортировать уроки по списку id (все id из текущего списка). */
  | { type: 'reorderLessons'; orderedIds: string[] }
  /** Заполнить кеш шагов урока (после getLesson / добавления). */
  | {
      type: 'setSteps';
      lessonId: string;
      steps: UserLessonStepDto[];
    }
  /** Добавить шаг к уроку (конец или после `afterStepId`). */
  | {
      type: 'addStep';
      lessonId: string;
      step: UserLessonStepDto;
      afterStepId?: string | null;
    }
  /** Патч одного шага (payload/order/type). */
  | {
      type: 'updateStep';
      lessonId: string;
      stepId: string;
      patch: Partial<UserLessonStepDto>;
    }
  /** Удалить шаг из урока. */
  | { type: 'deleteStep'; lessonId: string; stepId: string }
  /** Пересортировать шаги урока по списку id. */
  | {
      type: 'reorderSteps';
      lessonId: string;
      orderedIds: string[];
    }
  /** Обновить глобальный статус автосохранения (для `<SaveStatusPill>`). */
  | { type: 'setSaveStatus'; status: AutoSaveStatus };

// ─── Reducer (чистая функция) ─────────────────────────────────────────

export function userCourseReducer(
  state: UserCourseState,
  action: UserCourseAction,
): UserCourseState {
  switch (action.type) {
    case 'loadCourse':
      return {
        course: action.course,
        lessons: action.lessons
          .slice()
          .sort((a, b) => a.order - b.order),
        stepsByLesson: {},
        saveStatus: 'idle',
      };

    case 'updateCourseMeta':
      if (!state.course) return state;
      return { ...state, course: { ...state.course, ...action.patch } };

    case 'addLesson': {
      const exists = state.lessons.some((l) => l.id === action.lesson.id);
      if (exists) return state;
      const next = state.lessons.slice();
      if (action.afterLessonId) {
        const idx = next.findIndex((l) => l.id === action.afterLessonId);
        next.splice(idx === -1 ? next.length : idx + 1, 0, action.lesson);
      } else {
        next.push(action.lesson);
      }
      // Пересчёт `order` в соответствии с позицией в массиве.
      const withOrder = next.map((l, i) => ({ ...l, order: i }));
      return {
        ...state,
        lessons: withOrder,
        course: state.course
          ? { ...state.course, lessonCount: withOrder.length }
          : state.course,
      };
    }

    case 'updateLesson':
      return {
        ...state,
        lessons: state.lessons.map((l) =>
          l.id === action.id ? { ...l, ...action.patch } : l,
        ),
      };

    case 'deleteLesson': {
      const filtered = state.lessons
        .filter((l) => l.id !== action.id)
        .map((l, i) => ({ ...l, order: i }));
      const nextStepsByLesson = { ...state.stepsByLesson };
      delete nextStepsByLesson[action.id];
      return {
        ...state,
        lessons: filtered,
        stepsByLesson: nextStepsByLesson,
        course: state.course
          ? { ...state.course, lessonCount: filtered.length }
          : state.course,
      };
    }

    case 'reorderLessons': {
      const byId = new Map(state.lessons.map((l) => [l.id, l] as const));
      const reordered: UserLessonDto[] = [];
      action.orderedIds.forEach((id, i) => {
        const l = byId.get(id);
        if (l) reordered.push({ ...l, order: i });
      });
      // Уроки, которых нет в `orderedIds`, идут в конец в прежнем порядке.
      for (const l of state.lessons) {
        if (!action.orderedIds.includes(l.id)) {
          reordered.push({ ...l, order: reordered.length });
        }
      }
      return { ...state, lessons: reordered };
    }

    case 'setSteps':
      return {
        ...state,
        stepsByLesson: {
          ...state.stepsByLesson,
          [action.lessonId]: action.steps
            .slice()
            .sort((a, b) => a.order - b.order),
        },
      };

    case 'addStep': {
      const current = state.stepsByLesson[action.lessonId] ?? [];
      if (current.some((s) => s.id === action.step.id)) return state;
      const next = current.slice();
      if (action.afterStepId) {
        const idx = next.findIndex((s) => s.id === action.afterStepId);
        next.splice(idx === -1 ? next.length : idx + 1, 0, action.step);
      } else {
        next.push(action.step);
      }
      const withOrder = next.map((s, i) => ({ ...s, order: i }));
      return {
        ...state,
        stepsByLesson: { ...state.stepsByLesson, [action.lessonId]: withOrder },
        lessons: state.lessons.map((l) =>
          l.id === action.lessonId
            ? { ...l, stepCount: withOrder.length }
            : l,
        ),
      };
    }

    case 'updateStep': {
      const current = state.stepsByLesson[action.lessonId];
      if (!current) return state;
      const next = current.map((s) =>
        s.id === action.stepId ? { ...s, ...action.patch } : s,
      );
      return {
        ...state,
        stepsByLesson: { ...state.stepsByLesson, [action.lessonId]: next },
      };
    }

    case 'deleteStep': {
      const current = state.stepsByLesson[action.lessonId];
      if (!current) return state;
      const filtered = current
        .filter((s) => s.id !== action.stepId)
        .map((s, i) => ({ ...s, order: i }));
      return {
        ...state,
        stepsByLesson: {
          ...state.stepsByLesson,
          [action.lessonId]: filtered,
        },
        lessons: state.lessons.map((l) =>
          l.id === action.lessonId
            ? { ...l, stepCount: filtered.length }
            : l,
        ),
      };
    }

    case 'reorderSteps': {
      const current = state.stepsByLesson[action.lessonId];
      if (!current) return state;
      const byId = new Map(current.map((s) => [s.id, s] as const));
      const reordered: UserLessonStepDto[] = [];
      action.orderedIds.forEach((id, i) => {
        const s = byId.get(id);
        if (s) reordered.push({ ...s, order: i });
      });
      for (const s of current) {
        if (!action.orderedIds.includes(s.id)) {
          reordered.push({ ...s, order: reordered.length });
        }
      }
      return {
        ...state,
        stepsByLesson: {
          ...state.stepsByLesson,
          [action.lessonId]: reordered,
        },
      };
    }

    case 'setSaveStatus':
      return { ...state, saveStatus: action.status };

    default: {
      // Exhaustiveness-guard: TypeScript проверит, что все варианты
      // action.type покрыты. При добавлении нового action без case
      // здесь — ошибка компиляции.
      const _never: never = action;
      void _never;
      return state;
    }
  }
}

// ─── Hook wrapper ───────────────────────────────────────────────────

export interface UseUserCourseStateReturn {
  state: UserCourseState;
  actions: {
    loadCourse: (course: UserCourseDto, lessons: UserLessonDto[]) => void;
    updateCourseMeta: (patch: Partial<UserCourseDto>) => void;
    addLesson: (lesson: UserLessonDto, afterLessonId?: string | null) => void;
    updateLesson: (id: string, patch: Partial<UserLessonDto>) => void;
    deleteLesson: (id: string) => void;
    reorderLessons: (orderedIds: string[]) => void;
    setSteps: (lessonId: string, steps: UserLessonStepDto[]) => void;
    addStep: (
      lessonId: string,
      step: UserLessonStepDto,
      afterStepId?: string | null,
    ) => void;
    updateStep: (
      lessonId: string,
      stepId: string,
      patch: Partial<UserLessonStepDto>,
    ) => void;
    deleteStep: (lessonId: string, stepId: string) => void;
    reorderSteps: (lessonId: string, orderedIds: string[]) => void;
    setSaveStatus: (status: AutoSaveStatus) => void;
  };
}

export function useUserCourseState(
  initial?: UserCourseState,
): UseUserCourseStateReturn {
  const [state, dispatch] = useReducer(
    userCourseReducer,
    initial ?? initialUserCourseState,
  );

  const actions = {
    loadCourse: useCallback(
      (course: UserCourseDto, lessons: UserLessonDto[]) =>
        dispatch({ type: 'loadCourse', course, lessons }),
      [],
    ),
    updateCourseMeta: useCallback(
      (patch: Partial<UserCourseDto>) =>
        dispatch({ type: 'updateCourseMeta', patch }),
      [],
    ),
    addLesson: useCallback(
      (lesson: UserLessonDto, afterLessonId?: string | null) =>
        dispatch({ type: 'addLesson', lesson, afterLessonId }),
      [],
    ),
    updateLesson: useCallback(
      (id: string, patch: Partial<UserLessonDto>) =>
        dispatch({ type: 'updateLesson', id, patch }),
      [],
    ),
    deleteLesson: useCallback(
      (id: string) => dispatch({ type: 'deleteLesson', id }),
      [],
    ),
    reorderLessons: useCallback(
      (orderedIds: string[]) =>
        dispatch({ type: 'reorderLessons', orderedIds }),
      [],
    ),
    setSteps: useCallback(
      (lessonId: string, steps: UserLessonStepDto[]) =>
        dispatch({ type: 'setSteps', lessonId, steps }),
      [],
    ),
    addStep: useCallback(
      (
        lessonId: string,
        step: UserLessonStepDto,
        afterStepId?: string | null,
      ) => dispatch({ type: 'addStep', lessonId, step, afterStepId }),
      [],
    ),
    updateStep: useCallback(
      (
        lessonId: string,
        stepId: string,
        patch: Partial<UserLessonStepDto>,
      ) => dispatch({ type: 'updateStep', lessonId, stepId, patch }),
      [],
    ),
    deleteStep: useCallback(
      (lessonId: string, stepId: string) =>
        dispatch({ type: 'deleteStep', lessonId, stepId }),
      [],
    ),
    reorderSteps: useCallback(
      (lessonId: string, orderedIds: string[]) =>
        dispatch({ type: 'reorderSteps', lessonId, orderedIds }),
      [],
    ),
    setSaveStatus: useCallback(
      (status: AutoSaveStatus) =>
        dispatch({ type: 'setSaveStatus', status }),
      [],
    ),
  };

  return { state, actions };
}
