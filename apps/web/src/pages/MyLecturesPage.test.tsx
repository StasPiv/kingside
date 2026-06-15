/**
 * KS-3998. Тесты «не пустого» содержимого ⋮-меню в `MyLecturesPage`
 * для всех статусов лекции. До правки в KS-3998 поповер обрезался
 * по `overflow: hidden` контейнера-списка — пользователь видел
 * пустой прямоугольник без пунктов. Логически пункты в JSX
 * рендерятся для каждого статуса, и тест проверяет, что для
 * запланированной/идущей/записанной/отменённой лекций каждый
 * ожидаемый пункт меню есть в DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// MyLecturesPage читает `useAuth()` ради ownerId-фильтра (KS-3999).
// Мокаем как авторизованного пользователя с тем же id, что у `ownerId`
// лекций в тестовых данных.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', username: 'test', email: null },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { MyLecturesPage } from './MyLecturesPage';

function makeLecture(
  id: string,
  status: LectureStatus,
): LectureSummary {
  return {
    id,
    ownerId: 'u-1',
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

async function openMenuFor(id: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(`my-lectures-menu-${id}`));
  await waitFor(() =>
    expect(
      screen.getByTestId(`my-lectures-menu-popover-${id}`),
    ).toBeTruthy(),
  );
}

describe('<MyLecturesPage> KS-3999: фильтр ownerId === currentUserId', () => {
  it('показывает только лекции авторизованного пользователя, не из allowlist', async () => {
    const own = makeLecture('mine', 'scheduled');
    const someone = makeLecture('foreign', 'scheduled');
    (someone as { ownerId: string }).ownerId = 'other-user';
    apiGet.mockResolvedValueOnce({
      items: [own, someone],
      total: 2,
      hasMore: false,
    });
    renderWithProviders(<MyLecturesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('my-lectures-item-mine')).toBeTruthy(),
    );
    expect(screen.queryByTestId('my-lectures-item-foreign')).toBeNull();
  });
});

describe('<MyLecturesPage> KS-3998: ⋮-меню по статусам', () => {
  // KS-4179: кнопка «Start» для статуса scheduled из меню убрана
  // (старт лекции теперь происходит через отдельную кнопку на карточке,
  // не через ⋮-меню). Проверка `my-lectures-action-start-a` снята —
  // пункта в компоненте больше нет.
  it('scheduled: пункты Open / Settings / Copy link / Delete', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeLecture('a', 'scheduled')],
      total: 1,
      hasMore: false,
    });
    renderWithProviders(<MyLecturesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('my-lectures-list')).toBeTruthy(),
    );
    await openMenuFor('a');
    expect(screen.getByTestId('my-lectures-action-open-a')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-settings-a')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-share-a')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-delete-a')).toBeTruthy();
    expect(
      screen.queryByTestId('my-lectures-action-start-a'),
    ).toBeNull();
    expect(
      screen.queryByTestId('my-lectures-action-force-end-a'),
    ).toBeNull();
  });

  it('live: пункты Open / End broadcast / Settings / Copy link / Delete', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeLecture('b', 'live')],
      total: 1,
      hasMore: false,
    });
    renderWithProviders(<MyLecturesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('my-lectures-list')).toBeTruthy(),
    );
    await openMenuFor('b');
    expect(screen.getByTestId('my-lectures-action-open-b')).toBeTruthy();
    expect(
      screen.getByTestId('my-lectures-action-force-end-b'),
    ).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-settings-b')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-share-b')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-delete-b')).toBeTruthy();
    expect(
      screen.queryByTestId('my-lectures-action-start-b'),
    ).toBeNull();
  });

  it('recorded: Open / Settings / Copy link / Delete (без Start и End)', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeLecture('c', 'recorded')],
      total: 1,
      hasMore: false,
    });
    renderWithProviders(<MyLecturesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('my-lectures-list')).toBeTruthy(),
    );
    await openMenuFor('c');
    expect(screen.getByTestId('my-lectures-action-open-c')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-settings-c')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-share-c')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-delete-c')).toBeTruthy();
    expect(
      screen.queryByTestId('my-lectures-action-start-c'),
    ).toBeNull();
    expect(
      screen.queryByTestId('my-lectures-action-force-end-c'),
    ).toBeNull();
  });

  it('cancelled: Open / Copy link / Delete (без Settings, Start, End)', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeLecture('d', 'cancelled')],
      total: 1,
      hasMore: false,
    });
    renderWithProviders(<MyLecturesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('my-lectures-list')).toBeTruthy(),
    );
    await openMenuFor('d');
    expect(screen.getByTestId('my-lectures-action-open-d')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-share-d')).toBeTruthy();
    expect(screen.getByTestId('my-lectures-action-delete-d')).toBeTruthy();
    expect(
      screen.queryByTestId('my-lectures-action-settings-d'),
    ).toBeNull();
    expect(
      screen.queryByTestId('my-lectures-action-start-d'),
    ).toBeNull();
    expect(
      screen.queryByTestId('my-lectures-action-force-end-d'),
    ).toBeNull();
  });
});
