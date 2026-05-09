import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  UserCoursePlayProgressDto,
  UserEnrolledCourseDto,
} from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';

/**
 * KS-1890: `EnrolledCoursesBlock` — блок «Курсы, которые я прохожу»
 * на странице `/lessons`.
 *
 * Покрытие:
 *  - гость → блок скрыт;
 *  - пустой список → блок скрыт (DoD: «не плодить лишний UI»);
 *  - completedAt задан → бейдж «Done» виден;
 *  - completedAt = null → бейджа нет, виден прогресс «N/M lessons»;
 *  - ошибка `listEnrolled` → блок скрыт (тихо).
 */

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    listEnrolled: vi.fn(),
  },
  authMock: {
    user: { id: 'student-1', username: 'st', email: 'st@x' } as
      | { id: string; username: string; email: string }
      | null,
  },
}));

// KS-2645: переключено на lessonsApi.listEnrolled.
vi.mock('../../api/lessonsApi', () => ({
  lessonsApi: apiMock,
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

import { EnrolledCoursesBlock } from './EnrolledCoursesBlock';

function mkProgress(
  over: Partial<UserCoursePlayProgressDto> = {},
): UserCoursePlayProgressDto {
  return {
    userCourseId: 'c1',
    completedLessonsCount: 0,
    startedAt: '2026-04-20T10:00:00Z',
    lastActivityAt: '2026-04-20T10:00:00Z',
    completedAt: null,
    ...over,
  };
}

function mkEnrolled(
  over: Partial<UserEnrolledCourseDto> = {},
): UserEnrolledCourseDto {
  const id = over.id ?? 'c1';
  return {
    id,
    ownerId: 'other-author',
    slug: `slug-${id}`,
    title: `Course ${id}`,
    description: 'desc',
    isPublic: true,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    lessonCount: 3,
    progress: mkProgress({ userCourseId: id }),
    ...over,
  };
}

function renderWithRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<EnrolledCoursesBlock />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.listEnrolled.mockReset();
  authMock.user = { id: 'student-1', username: 'st', email: 'st@x' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<EnrolledCoursesBlock>', () => {
  it('гость → блок скрыт, API не дёргается', () => {
    authMock.user = null;
    renderWithRouter();
    expect(
      screen.queryByTestId('enrolled-courses-block'),
    ).not.toBeInTheDocument();
    expect(apiMock.listEnrolled).not.toHaveBeenCalled();
  });

  it('пустой список → блок скрыт (DoD)', async () => {
    apiMock.listEnrolled.mockResolvedValue({ data: [] });
    renderWithRouter();
    // ждём ответа
    await waitFor(() => expect(apiMock.listEnrolled).toHaveBeenCalled());
    expect(
      screen.queryByTestId('enrolled-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('Gherkin: completedAt → карточка с бейджем «Done», без него — без бейджа', async () => {
    apiMock.listEnrolled.mockResolvedValue({
      data: [
        mkEnrolled({
          id: 'a',
          title: 'Course A',
          progress: mkProgress({
            userCourseId: 'a',
            completedLessonsCount: 3,
            completedAt: '2026-04-22T10:00:00Z',
          }),
        }),
        mkEnrolled({
          id: 'b',
          title: 'Course B',
          lessonCount: 3,
          progress: mkProgress({
            userCourseId: 'b',
            completedLessonsCount: 1,
            completedAt: null,
          }),
        }),
      ],
    });
    renderWithRouter();
    await waitFor(() =>
      expect(screen.getByTestId('enrolled-courses-block')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('enrolled-courses-completed-a'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('enrolled-courses-completed-b'),
    ).not.toBeInTheDocument();
    // Прогресс «1/3 lessons» виден (KS-1884 plural)
    expect(
      screen.getByTestId('enrolled-courses-progress-b').textContent,
    ).toMatch(/1.*3/);
  });

  it('ошибка listEnrolled → блок скрыт (тихо, не ломает /lessons)', async () => {
    apiMock.listEnrolled.mockRejectedValue(new Error('boom'));
    renderWithRouter();
    await waitFor(() => expect(apiMock.listEnrolled).toHaveBeenCalled());
    expect(
      screen.queryByTestId('enrolled-courses-block'),
    ).not.toBeInTheDocument();
  });
});
