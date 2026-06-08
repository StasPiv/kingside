/**
 * KS-3999. Тест: `StudentLecturesPage` исключает собственные
 * лекции пользователя (`ownerId === user.id`). На каждом запросе
 * `useMyLectures({ status })` backend возвращает и owner-лекции,
 * и allowlist-лекции — ученический раздел должен показать только
 * последние.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { LectureStatus, LectureSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../test/test-utils';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'me', username: 'me', email: null },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { StudentLecturesPage } from './StudentLecturesPage';

function makeLecture(
  id: string,
  ownerId: string,
  status: LectureStatus,
): LectureSummary {
  return {
    id,
    ownerId,
    title: `Lecture ${id}`,
    description: null,
    scheduledAt: '2026-06-10T12:00:00.000Z',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    status,
    visibility: 'public',
    liveAnalysisId: null,
    recordingId: null,
    mediaUrl: null,
    mediaKind: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    liveAnalysis: null,
    disabledTools: [],
  };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('<StudentLecturesPage> KS-3999', () => {
  it('исключает собственные лекции из ученического раздела', async () => {
    // Три секции делают три запроса (live / scheduled / recorded).
    // На каждый возвращаем смесь «моих» и «чужих» лекций.
    const responses = (['live', 'scheduled', 'recorded'] as LectureStatus[]).map(
      (s) => ({
        items: [
          makeLecture(`own-${s}`, 'me', s),
          makeLecture(`other-${s}`, 'coach', s),
        ],
        total: 2,
        hasMore: false,
      }),
    );
    for (const r of responses) apiGet.mockResolvedValueOnce(r);

    renderWithProviders(<StudentLecturesPage />);

    await waitFor(() =>
      expect(
        screen.getByTestId('student-lectures-item-other-live'),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId('student-lectures-item-other-scheduled'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('student-lectures-item-other-recorded'),
    ).toBeTruthy();

    // Собственные лекции в раздел не попали.
    expect(
      screen.queryByTestId('student-lectures-item-own-live'),
    ).toBeNull();
    expect(
      screen.queryByTestId('student-lectures-item-own-scheduled'),
    ).toBeNull();
    expect(
      screen.queryByTestId('student-lectures-item-own-recorded'),
    ).toBeNull();
  });
});
