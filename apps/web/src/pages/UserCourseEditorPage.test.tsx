import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  UserCourseDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
} from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-1837 (FE-3): тесты `UserCourseEditorPage`.
 *
 * Покрытие:
 *  - loader → ready
 *  - owner-guard: чужой owner → редирект на /lessons
 *  - 4xx от backend → редирект на /lessons
 *  - debounced autosave (400мс < 500мс не стреляет; после 600мс — один PATCH)
 *  - add/delete lesson
 *  - StepEditor передаётся restrictToTypes=['text','puzzle','endgame_drill']
 */

const { apiMock } = vi.hoisted(() => {
  return {
    apiMock: {
      getBySlug: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createLesson: vi.fn(),
      updateLesson: vi.fn(),
      deleteLesson: vi.fn(),
      getLesson: vi.fn(),
      createStep: vi.fn(),
      updateStep: vi.fn(),
      deleteStep: vi.fn(),
      reorderSteps: vi.fn(),
      updateStepProgress: vi.fn(),
      completeLesson: vi.fn(),
      list: vi.fn(),
    },
  };
});

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'me', email: 'me@x', ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500, createdAt: '2026-01-01' },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// StepEditor — реальный компонент монтирует chessboard, не нужен для
// unit-теста страницы. Минимальная заглушка, сохраняющая prop-контракт.
vi.mock('../components/lessons/editor/StepEditor', () => ({
  StepEditor: (props: {
    step: { id: string };
    restrictToTypes?: string[];
  }) => (
    <div
      data-testid={`step-editor-${props.step.id}`}
      data-restrict={(props.restrictToTypes ?? []).join(',')}
    />
  ),
}));

import { UserCourseEditorPage } from './UserCourseEditorPage';

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  return {
    id: 'c1',
    ownerId: 'user-1',
    slug: 'my-course',
    title: 'My course',
    description: 'desc',
    isPublic: false,
    createdAt: '2026-04-24T10:00:00Z',
    updatedAt: '2026-04-24T10:00:00Z',
    lessonCount: 0,
    ...over,
  };
}

function mkLesson(over: Partial<UserLessonDto> = {}): UserLessonDto {
  return {
    id: 'l1',
    userCourseId: 'c1',
    order: 0,
    title: 'L1',
    estMinutes: null,
    stepCount: 0,
    ...over,
  };
}

function mockBySlug(response: UserCourseWithLessonsResponse | 'error') {
  if (response === 'error') {
    apiMock.getBySlug.mockRejectedValue(new Error('Not found'));
  } else {
    apiMock.getBySlug.mockResolvedValue(response);
  }
}

beforeEach(() => {
  // По умолчанию — реальные таймеры; отдельный debounce-тест включает
  // fake'и точечно (иначе Promise'ы initial load'а не резолвятся).
  for (const fn of Object.values(apiMock)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface RouterOpts {
  initialPath: string;
  lessonsPageStub?: boolean;
}

function renderWithRouter({ initialPath, lessonsPageStub }: RouterOpts) {
  return renderWithProviders(
    <Routes>
      <Route path="/lessons/my/:slug/edit" element={<UserCourseEditorPage />} />
      {lessonsPageStub && (
        <Route path="/lessons" element={<div data-testid="lessons-page" />} />
      )}
    </Routes>,
    { route: initialPath },
  );
}

describe('<UserCourseEditorPage>', () => {
  it('показывает loading → ready и форму с текущими значениями', async () => {
    mockBySlug({
      course: mkCourse({ title: 'Hello', description: 'Hi', isPublic: true }),
      lessons: [],
      progress: null,
    });
    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    expect(screen.getByTestId('user-course-editor-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );
    expect((screen.getByTestId('user-course-title') as HTMLInputElement).value).toBe('Hello');
    expect((screen.getByTestId('user-course-is-public') as HTMLInputElement).checked).toBe(true);
  });

  it('чужой owner → редирект на /lessons (editor не рендерится)', async () => {
    mockBySlug({
      course: mkCourse({ ownerId: 'someone-else' }),
      lessons: [],
      progress: null,
    });
    renderWithRouter({
      initialPath: '/lessons/my/my-course/edit',
      lessonsPageStub: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('lessons-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-course-editor')).not.toBeInTheDocument();
  });

  it('ошибка загрузки (404/403) → тоже редирект на /lessons', async () => {
    mockBySlug('error');
    renderWithRouter({
      initialPath: '/lessons/my/missing/edit',
      lessonsPageStub: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('lessons-page')).toBeInTheDocument(),
    );
  });

  it('debounced autosave: набор текста в title → 1 PATCH через 500мс (не сразу)', async () => {
    mockBySlug({
      course: mkCourse(),
      lessons: [],
      progress: null,
    });
    apiMock.update.mockResolvedValue(mkCourse({ title: 'Renamed' }));

    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );

    // Фейкаем таймеры ТОЛЬКО после того, как initial-load завершился:
    // иначе микрозадачи resolve'а не дойдут до setState (fake-timers
    // не продвигают Promise'ы, только setTimeout).
    vi.useFakeTimers();

    const input = screen.getByTestId('user-course-title') as HTMLInputElement;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'R' } });
    fireEvent.change(input, { target: { value: 'Re' } });
    fireEvent.change(input, { target: { value: 'Renamed' } });

    // На 400мс — PATCH'а ещё нет.
    vi.advanceTimersByTime(400);
    expect(apiMock.update).not.toHaveBeenCalled();

    // На 500+ мс — один PATCH с финальным значением.
    vi.advanceTimersByTime(200);
    expect(apiMock.update).toHaveBeenCalledTimes(1);
    expect(apiMock.update.mock.calls[0][0]).toBe('c1');
    expect(apiMock.update.mock.calls[0][1]).toEqual({
      title: 'Renamed',
      description: undefined,
      isPublic: undefined,
    });
  });

  it('Add lesson → POST createLesson и карточка появляется', async () => {
    mockBySlug({
      course: mkCourse(),
      lessons: [],
      progress: null,
    });
    apiMock.createLesson.mockResolvedValueOnce(mkLesson({ id: 'l-new', title: 'New lesson' }));

    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-editor-add-lesson'));

    await waitFor(() =>
      expect(apiMock.createLesson).toHaveBeenCalledWith('c1', expect.objectContaining({ title: expect.any(String) })),
    );
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor-lesson-l-new')).toBeInTheDocument(),
    );
  });

  it('StepEditor получает restrictToTypes=["text","puzzle","endgame_drill"]', async () => {
    mockBySlug({
      course: mkCourse({ lessonCount: 1 }),
      lessons: [mkLesson({ stepCount: 1 })],
      progress: null,
    });
    apiMock.getLesson.mockResolvedValueOnce({
      lesson: mkLesson({ stepCount: 1 }),
      steps: [
        {
          id: 's1',
          userLessonId: 'l1',
          order: 0,
          type: 'text',
          payload: { type: 'text', bodyMarkdown: 'hi', diagrams: [] },
        },
      ],
      progress: null,
    });

    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );

    const details = screen.getByTestId('user-course-editor-lesson-l1') as HTMLDetailsElement;
    details.open = true;
    // happy-dom не диспатчит 'toggle' при программном установке `.open`;
    // посылаем событие вручную, чтобы сработал onToggle-хендлер.
    details.dispatchEvent(new Event('toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('step-editor-s1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('step-editor-s1').getAttribute('data-restrict')).toBe(
      'text,puzzle,endgame_drill',
    );
  });

  // ─── KS-1843 (FE-9): дополнение покрытия editor-page ────────────────

  it('toggle isPublic чекбокса → debounced PATCH с isPublic:true', async () => {
    mockBySlug({
      course: mkCourse({ isPublic: false }),
      lessons: [],
      progress: null,
    });
    apiMock.update.mockResolvedValue(mkCourse({ isPublic: true }));

    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );

    // Включаем fake-timers только после initial-load (см. debounce-тест выше).
    vi.useFakeTimers();

    const checkbox = screen.getByTestId('user-course-is-public') as HTMLInputElement;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(checkbox);

    // 400мс — PATCH'а ещё нет.
    vi.advanceTimersByTime(400);
    expect(apiMock.update).not.toHaveBeenCalled();

    // 500+ мс — PATCH.
    vi.advanceTimersByTime(200);
    expect(apiMock.update).toHaveBeenCalledTimes(1);
    expect(apiMock.update.mock.calls[0][1]).toEqual({
      title: undefined,
      description: undefined,
      isPublic: true,
    });
  });

  it('Delete course (confirm=true) → DELETE + navigate /lessons', async () => {
    mockBySlug({
      course: mkCourse(),
      lessons: [],
      progress: null,
    });
    apiMock.delete.mockResolvedValue(undefined);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);

    renderWithRouter({
      initialPath: '/lessons/my/my-course/edit',
      lessonsPageStub: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-editor-delete'));

    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(screen.getByTestId('lessons-page')).toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  });

  it('Delete lesson → вызывает userCoursesApi.deleteLesson с id', async () => {
    mockBySlug({
      course: mkCourse(),
      lessons: [mkLesson({ id: 'l1', title: 'To delete' })],
      progress: null,
    });
    apiMock.deleteLesson.mockResolvedValue(undefined);

    renderWithRouter({ initialPath: '/lessons/my/my-course/edit' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-editor-lesson-l1')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    // Клик обёрнут в `e.stopPropagation()` поверх summary — напрямую дёргаем
    // элемент по testid, чтобы не зависеть от деталей details/summary в happy-dom.
    fireEvent.click(screen.getByTestId('user-course-editor-lesson-delete-l1'));

    await waitFor(() =>
      expect(apiMock.deleteLesson).toHaveBeenCalledWith('l1'),
    );
  });
});
