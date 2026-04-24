import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

/**
 * Тесты `LessonEditorPage`.
 *
 * role-guard реализован через `VITE_LESSON_EDITOR_EMAILS` в
 * `import.meta.env`. Vite подставит значение при старте приложения, в
 * тестах используем `vi.stubEnv`.
 *
 * `AuthContext` тянет API-запрос `/auth/me` при монтировании — для
 * unit-теста страницы мы не проверяем auth-флоу, а мокаем `useAuth`
 * напрямую.
 */

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// Настоящий PuzzleStep тянет chess.js + PuzzleBoard; Preview в StepRenderer
// по дефолту использует text → TextStep, но квиз/пазл также рендерятся в
// `<StepEditor>` внутри preview. Чтобы не тянуть тяжёлые зависимости,
// мокаем PuzzleStep/QuizStep/PositionStep/VideoStep.
vi.mock('../components/lessons/steps/PuzzleStep', () => ({
  PuzzleStep: () => <div data-testid="puzzle-step-mock" />,
}));
vi.mock('../components/lessons/steps/QuizStep', () => ({
  QuizStep: () => <div data-testid="quiz-step-mock" />,
}));
vi.mock('../components/lessons/steps/PositionStep', () => ({
  PositionStep: () => <div data-testid="position-step-mock" />,
}));
vi.mock('../components/lessons/steps/VideoStep', () => ({
  VideoStep: () => <div data-testid="video-step-mock" />,
}));
vi.mock('../components/lessons/steps/GameReviewStep', () => ({
  GameReviewStep: () => <div data-testid="game-review-step-mock" />,
}));
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

import { LessonEditorPage, isEmailAllowedForEditor } from './LessonEditorPage';

beforeEach(() => {
  mockUseAuth.mockReset();
  vi.unstubAllEnvs();
});

describe('isEmailAllowedForEditor', () => {
  it('пустой whitelist → никогда не разрешён', () => {
    expect(isEmailAllowedForEditor('a@b.c', '')).toBe(false);
    expect(isEmailAllowedForEditor('a@b.c', '   ')).toBe(false);
  });

  it('email в whitelist → разрешён (без учёта регистра)', () => {
    expect(isEmailAllowedForEditor('Admin@KingSide.io', 'admin@kingside.io')).toBe(true);
    expect(isEmailAllowedForEditor('admin@kingside.io', 'ADMIN@KINGSIDE.IO')).toBe(true);
  });

  it('email НЕ в whitelist → запрещён', () => {
    expect(isEmailAllowedForEditor('u@other.io', 'admin@kingside.io')).toBe(false);
  });

  it('несколько email в whitelist → проверяет все', () => {
    const wl = 'a@kingside.io, b@kingside.io, c@kingside.io';
    expect(isEmailAllowedForEditor('b@kingside.io', wl)).toBe(true);
    expect(isEmailAllowedForEditor('x@kingside.io', wl)).toBe(false);
  });

  it('wildcard * → любой залогиненный разрешён (dev-only)', () => {
    expect(isEmailAllowedForEditor('anyone@somewhere.io', '*')).toBe(true);
    expect(isEmailAllowedForEditor('anyone@somewhere.io', 'a@b.c, *')).toBe(true);
    // undefined email всё равно запрещён
    expect(isEmailAllowedForEditor(undefined, '*')).toBe(false);
  });

  it('undefined email → запрещён', () => {
    expect(isEmailAllowedForEditor(undefined, 'a@b.c')).toBe(false);
  });
});

describe('<LessonEditorPage>', () => {
  const baseUser = {
    id: 'u1',
    username: 'admin',
    email: 'admin@kingside.io',
    ratingBullet: 1200,
    ratingBlitz: 1200,
    ratingRapid: 1200,
    ratingClassical: 1200,
    ratingPuzzle: 1200,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('не залогинен → показывается заглушка', () => {
    mockUseAuth.mockReturnValue({ user: null });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    expect(screen.getByTestId('lesson-editor-denied')).toBeInTheDocument();
  });

  it('email не в whitelist → показывается forbidden-заглушка', () => {
    mockUseAuth.mockReturnValue({ user: { ...baseUser, email: 'random@x.io' } });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    expect(screen.getByTestId('lesson-editor-denied')).toBeInTheDocument();
  });

  it('whitelisted email → показывается форма редактора', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    expect(screen.getByTestId('lesson-editor')).toBeInTheDocument();
    expect(screen.getByTestId('editor-course-slug')).toBeInTheDocument();
    expect(screen.getByTestId('editor-add-lesson')).toBeInTheDocument();
  });

  it('добавление урока → появляется в списке', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    fireEvent.click(screen.getByTestId('editor-add-lesson'));
    expect(
      screen.queryByTestId('editor-lessons-empty'),
    ).not.toBeInTheDocument();
    // Урок открылся автоматически — `editor-lesson-slug` виден
    expect(screen.getByTestId('editor-lesson-slug')).toBeInTheDocument();
  });

  it('экспорт валидирует обязательные поля (slug курса)', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    fireEvent.click(screen.getByTestId('editor-export-btn'));
    expect(screen.getByTestId('editor-status')).toHaveTextContent(
      /slug is required/i,
    );
  });

  it('экспорт при валидных данных → выдаёт сообщение «Fixture exported.»', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');

    // Моккаем createObjectURL + клик по <a>, чтобы happy-dom не упал.
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();

    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });

    // Заполняем минимум: slug + titleI18nKey.
    fireEvent.change(screen.getByTestId('editor-course-slug'), {
      target: { value: 'beginner' },
    });
    fireEvent.change(screen.getByTestId('editor-course-title-key'), {
      target: { value: 'courses.beginner.title' },
    });

    fireEvent.click(screen.getByTestId('editor-export-btn'));

    expect(screen.getByTestId('editor-status')).toHaveTextContent(
      /exported/i,
    );

    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('добавление шага → появляется StepEditor', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    fireEvent.click(screen.getByTestId('editor-add-lesson'));
    fireEvent.click(screen.getByTestId('editor-add-step'));
    // Первый шаг — по умолчанию type=text
    expect(screen.getByTestId('editor-step-text-body')).toBeInTheDocument();
  });

  it('смена типа шага на puzzle → рендерятся puzzle-поля', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    fireEvent.click(screen.getByTestId('editor-add-lesson'));
    fireEvent.click(screen.getByTestId('editor-add-step'));
    const typeSelect = document.querySelector(
      '[data-testid^="editor-step-type-"]',
    );
    expect(typeSelect).toBeTruthy();
    fireEvent.change(typeSelect as HTMLSelectElement, {
      target: { value: 'puzzle' },
    });
    expect(screen.getByTestId('editor-step-puzzle-mode')).toBeInTheDocument();
    expect(screen.getByTestId('editor-step-puzzle-ids')).toBeInTheDocument();
  });

  it('удаление урока → список пустеет', () => {
    mockUseAuth.mockReturnValue({ user: baseUser });
    vi.stubEnv('VITE_LESSON_EDITOR_EMAILS', 'admin@kingside.io');
    renderWithProviders(<LessonEditorPage />, { route: '/lessons/editor' });
    fireEvent.click(screen.getByTestId('editor-add-lesson'));
    const removeBtn = document.querySelector(
      '[data-testid^="editor-lesson-remove-"]',
    ) as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn);
    expect(
      screen.getByTestId('editor-lessons-empty'),
    ).toBeInTheDocument();
  });
});
