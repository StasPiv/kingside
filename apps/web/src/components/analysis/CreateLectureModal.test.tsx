/**
 * KS-3911 / ADR-117 B01. Тесты секции «Доступ учеников к инструментам»
 * в `CreateLectureModal`:
 *  - дефолт — все галочки стоят, в POST уходит пустой `disabledTools`;
 *  - снятие двух галочек — массив из двух соответствующих значений
 *    `LectureDisabledTool`, остальные остаются разрешены.
 *
 * KS-4000. Добавлены тесты режима «привязать к существующей
 * запланированной лекции». В этом режиме сабмит уходит в
 * `POST /lectures/:id/start` с телом `{analysisId}`, поля
 * title/description/tools/access скрыты. Список scheduled-лекций
 * приходит из `GET /my/lectures?status=scheduled` — мокаем
 * `api.get`, чтобы хук `useMyLectures` отдал детерминированный
 * набор. Фильтр по `ownerId === user.id` (KS-3999) проверяем
 * отдельным кейсом — чужая лекция в выпадающем списке не
 * появляется.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LectureSummary } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { ALL_LECTURE_DISABLED_TOOLS } from '@kingside/shared';

const apiPost = vi.fn();
const apiGet = vi.fn();
vi.mock('../../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

// useAuth нужен модалке для фильтра scheduled-лекций по ownerId.
// В тестах разворачиваем минимальный mock — авторизованный
// пользователь с id, который мы используем как ownerId в makeLecture.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'me', username: 'me', email: null },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { CreateLectureModal } from './CreateLectureModal';

const ANALYSIS_ID = 'analysis-123';

function defaultResponse() {
  return {
    lecture: { id: 'lec-1', title: 'Test lecture' },
    liveAnalysis: { id: 'live-1', slug: 'slug-1', url: '/live/slug-1' },
  };
}

function makeLecture(
  id: string,
  ownerId: string,
  overrides: Partial<LectureSummary> = {},
): LectureSummary {
  return {
    id,
    ownerId,
    title: `Lecture ${id}`,
    description: null,
    scheduledAt: '2026-07-01T15:00:00.000Z',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    status: 'scheduled',
    visibility: 'public',
    liveAnalysisId: null,
    recordingId: null,
    mediaUrl: null,
    mediaKind: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    liveAnalysis: null,
    disabledTools: [],
    ...overrides,
  };
}

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue(defaultResponse());
  apiGet.mockReset();
  // По умолчанию scheduled-список пуст — старые тесты не
  // зависят от выпадающего меню. Конкретные тесты привязки
  // переопределяют ответ через mockResolvedValueOnce.
  apiGet.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('<CreateLectureModal> KS-3911', () => {
  it('по умолчанию все чекбоксы инструментов отмечены', () => {
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    for (const tool of ALL_LECTURE_DISABLED_TOOLS) {
      const cb = screen.getByTestId(
        `create-lecture-tool-${tool}`,
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
  });

  it('submit без снятых галочек → disabledTools: []', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Caro-Kann basics"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    // Заголовок уже подставлен через defaultTitle, можно сразу сабмитить.
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/lectures');
    expect(body.analysisId).toBe(ANALYSIS_ID);
    expect(body.title).toBe('Caro-Kann basics');
    expect(body.disabledTools).toEqual([]);
  });

  it('снятие двух галочек → disabledTools содержит ровно эти два значения', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    // Снимаем галочки с движка и AI-комментария — ученикам они должны
    // прийти в `disabledTools` как запрет.
    await user.click(screen.getByTestId('create-lecture-tool-engine'));
    await user.click(screen.getByTestId('create-lecture-tool-ai_comment'));

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    const disabled = body.disabledTools as string[];

    // Сравнение через множества — порядок в массиве не специфицирован
    // контрактом (`ALL_LECTURE_DISABLED_TOOLS.filter` сохраняет порядок
    // whitelist'а, но тест не должен зависеть от внутренней реализации).
    expect(new Set(disabled)).toEqual(new Set(['engine', 'ai_comment']));
    expect(disabled).toHaveLength(2);
  });

  it('повторный клик по чекбоксу возвращает инструмент в разрешённые', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('create-lecture-tool-book'));
    await user.click(screen.getByTestId('create-lecture-tool-book'));

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.disabledTools).toEqual([]);
  });
});

describe('<CreateLectureModal> KS-3997 (initialAccessUserIds)', () => {
  it('public по умолчанию: initialAccessUserIds в POST нет', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.visibility).toBe('public');
    expect(body).not.toHaveProperty('initialAccessUserIds');
  });

  it('restricted без выбранных пользователей: initialAccessUserIds в POST нет', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('lecture-access-visibility-restricted'));
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.visibility).toBe('restricted');
    expect(body).not.toHaveProperty('initialAccessUserIds');
  });

  it('переключение с restricted (+ users) на public очищает буфер: ids в POST нет', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    // restricted → найден ввод поиска
    await user.click(screen.getByTestId('lecture-access-visibility-restricted'));
    expect(
      screen.getByTestId('lecture-access-pending-allowlist'),
    ).toBeTruthy();

    // переключаемся обратно на public
    await user.click(screen.getByTestId('lecture-access-visibility-public'));

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.visibility).toBe('public');
    expect(body).not.toHaveProperty('initialAccessUserIds');
  });
});

describe('<CreateLectureModal> KS-4000 (bind to scheduled)', () => {
  it('по умолчанию выбран «Создать новую» и поля видны', async () => {
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const select = screen.getByTestId(
      'create-lecture-bind-select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByTestId('create-lecture-tools-section')).toBeTruthy();
    expect(screen.getByTestId('create-lecture-access-section')).toBeTruthy();
  });

  it('в выпадающий список попадают только лекции с ownerId === user.id', async () => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({
      items: [
        makeLecture('mine-1', 'me'),
        makeLecture('foreign-1', 'other-user'),
      ],
      total: 2,
      hasMore: false,
    });
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('create-lecture-bind-option-mine-1'),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByTestId('create-lecture-bind-option-foreign-1'),
    ).toBeNull();
  });

  it('выбор привязки скрывает поля title/tools/access', async () => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({
      items: [makeLecture('lec-x', 'me')],
      total: 1,
      hasMore: false,
    });
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('create-lecture-bind-option-lec-x'),
      ).toBeTruthy(),
    );
    await user.selectOptions(
      screen.getByTestId('create-lecture-bind-select'),
      'lec-x',
    );
    expect(screen.queryByTestId('create-lecture-tools-section')).toBeNull();
    expect(screen.queryByTestId('create-lecture-access-section')).toBeNull();
    expect(screen.getByTestId('create-lecture-bind-info')).toBeTruthy();
  });

  it('сабмит с привязкой → POST /lectures/:id/start { analysisId }', async () => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({
      items: [makeLecture('lec-x', 'me')],
      total: 1,
      hasMore: false,
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('create-lecture-bind-option-lec-x'),
      ).toBeTruthy(),
    );
    await user.selectOptions(
      screen.getByTestId('create-lecture-bind-select'),
      'lec-x',
    );

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/lectures/lec-x/start');
    expect(body).toEqual({ analysisId: ANALYSIS_ID });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('<CreateLectureModal> KS-4045 hideMetricsTab', () => {
  it('по умолчанию `hideMetricsTab=false` — метрики у учеников видны', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.hideMetricsTab).toBe(false);
  });

  it('установка чекбокса → `hideMetricsTab=true` в payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await user.click(
      screen.getByTestId('create-lecture-hide-metrics-tab'),
    );
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.hideMetricsTab).toBe(true);
  });
});
