import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserCourseDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';

/**
 * KS-1840 (FE-6): `MyCoursesBlock`.
 *
 * Покрытие:
 *  - гость (user=null) → блок скрыт
 *  - список пуст → пустое состояние + CTA
 *  - список не пуст → карточки с title/description/isPublic бейджем
 *  - CTA «Создать» → POST /user-courses → navigate /lessons/my/:slug/edit
 *  - ошибка `list` → блок скрыт (не ломает системные курсы)
 *  - ошибка `create` → сообщение об ошибке, без navigate
 */

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    list: vi.fn(),
    create: vi.fn(),
    // KS-1882: MyCoursesBlock теперь подгружает прогресс по
    // каждому курсу (для completion-индикатора). Дефолт — null,
    // отдельные тесты на completion переопределяют.
    getCourseProgress: vi.fn().mockResolvedValue(null),
  },
  authMock: {
    user: { id: 'user-1', username: 'me', email: 'me@x' } as
      | { id: string; username: string; email: string }
      | null,
  },
}));

vi.mock('../../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
          createdAt: '2026-01-01',
        }
      : null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { MyCoursesBlock } from './MyCoursesBlock';

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
    lessonCount: 2,
    ...over,
  };
}

function renderWithRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<MyCoursesBlock />} />
      <Route
        path="/lessons/my/:slug/edit"
        element={<div data-testid="editor-page" />}
      />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.list.mockReset();
  apiMock.create.mockReset();
  apiMock.getCourseProgress.mockReset();
  apiMock.getCourseProgress.mockResolvedValue(null);
  authMock.user = { id: 'user-1', username: 'me', email: 'me@x' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MyCoursesBlock>', () => {
  it('гость (user=null) → блок не рендерится', async () => {
    authMock.user = null;
    apiMock.list.mockResolvedValue({ data: [] });
    renderWithRouter();
    expect(screen.queryByTestId('my-courses-block')).not.toBeInTheDocument();
    // Не дёргаем api без user
    expect(apiMock.list).not.toHaveBeenCalled();
  });

  it('список пуст → пустое состояние + CTA', async () => {
    apiMock.list.mockResolvedValue({ data: [] });
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-empty')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('my-courses-create')).toBeInTheDocument();
    expect(apiMock.list).toHaveBeenCalledWith({ scope: 'own' });
  });

  it('список не пуст → карточки с title / isPublic бейджем', async () => {
    apiMock.list.mockResolvedValue({
      data: [
        mkCourse({ id: 'c1', title: 'A', isPublic: false }),
        mkCourse({ id: 'c2', title: 'B', isPublic: true }),
      ],
    });
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-grid')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('my-courses-card-c1')).toBeInTheDocument();
    expect(screen.getByTestId('my-courses-card-c2')).toBeInTheDocument();
    expect(screen.getByTestId('my-courses-badge-c1').textContent).toMatch(/private/i);
    expect(screen.getByTestId('my-courses-badge-c2').textContent).toMatch(/public/i);
  });

  it('CTA «Создать» → POST + navigate /lessons/my/:slug/edit', async () => {
    apiMock.list.mockResolvedValue({ data: [] });
    apiMock.create.mockResolvedValue(mkCourse({ slug: 'new-course' }));
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-empty')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('my-courses-create'));

    await waitFor(() =>
      expect(apiMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.any(String) }),
      ),
    );
    await waitFor(
      () => expect(screen.getByTestId('editor-page')).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('ошибка list → блок не рендерится (без regression системных курсов)', async () => {
    apiMock.list.mockRejectedValue(new Error('boom'));
    renderWithRouter();
    // Ждём микротик чтобы промис с ошибкой обработался
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() =>
      expect(screen.queryByTestId('my-courses-block')).not.toBeInTheDocument(),
    );
  });

  /**
   * KS-1882: completion-индикатор на карточке курса.
   * Карточка получает класс `--completed` и видимый бейдж «Done»
   * только если getCourseProgress() вернул объект с completedAt.
   */
  it('KS-1882 — карточка показывает badge «Done» если completedAt задан', async () => {
    apiMock.list.mockResolvedValue({
      data: [
        mkCourse({ id: 'c1', title: 'Done one' }),
        mkCourse({ id: 'c2', title: 'Still going' }),
      ],
    });
    apiMock.getCourseProgress.mockImplementation(async (id: string) =>
      id === 'c1'
        ? {
            userCourseId: 'c1',
            completedLessonsCount: 5,
            startedAt: '2026-04-20T10:00:00Z',
            lastActivityAt: '2026-04-21T10:00:00Z',
            completedAt: '2026-04-21T10:00:00Z',
          }
        : null,
    );

    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-grid')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-completed-c1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('my-courses-completed-c2')).not.toBeInTheDocument();
  });

  it('KS-1882 — completedAt = null → бейджа нет', async () => {
    apiMock.list.mockResolvedValue({ data: [mkCourse({ id: 'c1' })] });
    apiMock.getCourseProgress.mockResolvedValue({
      userCourseId: 'c1',
      completedLessonsCount: 1,
      startedAt: '2026-04-20T10:00:00Z',
      lastActivityAt: '2026-04-20T10:00:00Z',
      completedAt: null,
    });
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-card-c1')).toBeInTheDocument(),
    );
    // Дать времени Promise.all с прогрессом отработать
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('my-courses-completed-c1')).not.toBeInTheDocument();
  });

  /**
   * KS-1886: компактный счётчик `stats` в карточке курса. BE
   * отдаёт `stats` на UserCourseDto только владельцу. FE рендерит
   * его без дополнительной проверки isOwner — серверная фильтрация
   * достаточна.
   */
  it('KS-1886 — карточка показывает компактный счётчик при наличии stats', async () => {
    apiMock.list.mockResolvedValue({
      data: [
        mkCourse({
          id: 'c1',
          stats: { enrolledCount: 5, completedCount: 2, inProgressCount: 3 },
        }),
        mkCourse({ id: 'c2' }), // без stats — счётчика быть не должно
      ],
    });
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-grid')).toBeInTheDocument(),
    );
    const stats = screen.getByTestId('my-courses-stats-c1');
    expect(stats).toBeInTheDocument();
    expect(stats.textContent).toContain('5');
    expect(stats.textContent).toContain('2');
    expect(screen.queryByTestId('my-courses-stats-c2')).not.toBeInTheDocument();
  });

  it('KS-1882 — провал getCourseProgress не ломает карточку', async () => {
    apiMock.list.mockResolvedValue({ data: [mkCourse({ id: 'c1' })] });
    apiMock.getCourseProgress.mockRejectedValue(new Error('boom'));
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-card-c1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('my-courses-completed-c1')).not.toBeInTheDocument();
  });

  it('ошибка create → сообщение об ошибке, без navigate', async () => {
    apiMock.list.mockResolvedValue({ data: [] });
    apiMock.create.mockRejectedValue(new Error('nope'));
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('my-courses-empty')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('my-courses-create'));

    await waitFor(() =>
      expect(screen.getByTestId('my-courses-create-error')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('editor-page')).not.toBeInTheDocument();
  });
});
