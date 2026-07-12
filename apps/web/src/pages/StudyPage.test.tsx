// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n/index';
import { StudyPage, taskLink, findMainLesson } from './StudyPage';
import { api } from '../api';
import type { StudyScheduleDto, StudySessionDto, StudyTaskDto } from '@kingside/shared';

/**
 * KS-4883 / ADR-160. Страница /study: состояния «нет расписания»
 * (CTA в настройки) и «расписание есть, занятие не запланировано».
 */

const SCHEDULE: StudyScheduleDto = {
  id: 's1',
  daysOfWeek: [1, 3, 5],
  timeLocal: '19:30',
  timezone: 'Europe/Prague',
  sessionMinutes: 45,
  focus: null,
  active: true,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

function makeTask(over: Partial<StudyTaskDto> = {}): StudyTaskDto {
  return {
    id: 't1',
    position: 0,
    type: 'puzzle_theme',
    params: { theme: 'fork', ratingMin: 1400, ratingMax: 1550 },
    targetCount: 10,
    doneCount: 0,
    status: 'pending',
    ...over,
  };
}

const SESSION: StudySessionDto = {
  id: 'sess1',
  scheduledAt: '2026-07-11T19:30:00.000Z',
  status: 'notified',
  completedAt: null,
  tasks: [
    makeTask(),
    makeTask({
      id: 't2',
      position: 1,
      type: 'lesson',
      params: { lessonId: 'l1', courseId: 'c1', courseSlug: 'endgame-basics' },
      targetCount: 1,
      doneCount: 1,
      status: 'done',
    }),
  ],
};

function mockGet(
  schedule: StudyScheduleDto | null,
  session: StudySessionDto | null = null,
  opts: { hasAccounts?: boolean; pgnFiles?: unknown[] } = {},
) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/study/schedule') return { schedule };
    if (path === '/study/channels') return { channels: [] };
    if (path === '/study/session') return { session };
    if (path === '/users/me/settings') {
      return opts.hasAccounts ? { lichessUsername: 'someone' } : {};
    }
    if (path === '/workshop/pgn-files') return { data: opts.pgnFiles ?? [] };
    throw new Error(`unexpected GET ${path}`);
  });
}

/** Сессия v2: main-урок + homework. */
const SESSION_V2: StudySessionDto = {
  id: 'sess2',
  scheduledAt: '2026-07-12T19:30:00.000Z',
  status: 'notified',
  completedAt: null,
  tasks: [
    makeTask({
      id: 'm1',
      position: 0,
      type: 'lesson',
      params: {
        lessonId: 'lesson-uuid-1',
        courseId: 'course-uuid-1',
        courseSlug: 'my-study-course',
        themeLabel: 'Вилки',
      },
      targetCount: 1,
      doneCount: 0,
      status: 'pending',
    }),
    makeTask({ id: 'h1', position: 1, type: 'puzzle_theme', status: 'pending' }),
    makeTask({ id: 'h2', position: 2, type: 'mistakes', params: {}, status: 'pending' }),
  ],
};

function wrap() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <StudyPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('StudyPage (KS-4883)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('без расписания — приглашение настроить со ссылкой в /settings?tab=study', async () => {
    mockGet(null);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-empty-no-schedule')).toBeInTheDocument(),
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/settings?tab=study');
  });

  it('с расписанием — «занятие пока не запланировано»', async () => {
    mockGet(SCHEDULE);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-empty-no-session')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('study-empty-no-schedule')).not.toBeInTheDocument();
  });

  it('занятие: статус, прогресс, задания с doneCount/targetCount и ссылками', async () => {
    mockGet(SCHEDULE, SESSION, { hasAccounts: true });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-session')).toBeInTheDocument());
    // Общий прогресс: 1 из 2 done.
    expect(screen.getByTestId('study-session-progress').textContent).toContain('1');
    expect(screen.getByTestId('study-session-progress').textContent).toContain('2');
    // Задание 0 — пазлы по теме, ссылка с фильтрами.
    const row0 = screen.getByTestId('study-task-0');
    const link0 = row0.querySelector('a');
    expect(link0?.getAttribute('href')).toBe('/puzzles?themes=fork&ratingMin=1400&ratingMax=1550');
    expect(screen.getByTestId('study-task-0-progress').textContent).toBe('0/10');
    // KS-4912: задание type='lesson' (в SESSION оно done, lessonId в
    // params) рендерится карточкой урока, не строкой списка.
    expect(screen.getByTestId('study-lesson-done')).toBeInTheDocument();
    expect(screen.queryByTestId('study-task-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('study-empty-no-session')).not.toBeInTheDocument();
  });

  it('taskLink: маршруты всех типов заданий', () => {
    expect(taskLink(makeTask({ type: 'sm2_review', params: { lessonIds: ['a'] } }))).toBe('/lessons');
    expect(taskLink(makeTask({ type: 'mistakes', params: {} }))).toBe('/puzzles/mistakes-practice');
    expect(taskLink(makeTask({ type: 'precision', params: {} }))).toBe('/precision');
    expect(taskLink(makeTask({ type: 'drill', params: {} }))).toBe('/drills');
    expect(taskLink(makeTask({ type: 'rated_game', params: {} }))).toBe('/play');
    expect(taskLink(makeTask({ type: 'game_review', params: {} }))).toBe('/profile');
    expect(taskLink(makeTask({ type: 'puzzle_rush', params: { timeMode: '5m' } }))).toBe('/puzzle-rush');
    expect(taskLink(makeTask({ type: 'external_games', params: {} }))).toBeNull();
    expect(taskLink(makeTask({ type: 'puzzle_theme', params: {} }))).toBe('/puzzles');
  });

  it('v2: main-урок — карточка с темой и кнопкой в плеер, homework отдельно', async () => {
    mockGet(SCHEDULE, SESSION_V2, { hasAccounts: true });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-lesson-card')).toBeInTheDocument());
    expect(screen.getByTestId('study-lesson-theme').textContent).toContain('Вилки');
    const start = screen.getByTestId('study-lesson-start');
    expect(start.getAttribute('href')).toBe('/lessons/my-study-course/lesson-uuid-1');
    // Homework: 2 задачи, main-урок в списке отсутствует.
    expect(screen.getByTestId('study-homework-title')).toBeInTheDocument();
    expect(screen.getByTestId('study-task-1')).toBeInTheDocument();
    expect(screen.getByTestId('study-task-2')).toBeInTheDocument();
    expect(screen.queryByTestId('study-task-0')).not.toBeInTheDocument();
  });

  it('v2: завершённый main-урок — отметка вместо кнопки', async () => {
    const done = {
      ...SESSION_V2,
      tasks: SESSION_V2.tasks.map((t) =>
        t.id === 'm1' ? { ...t, status: 'done' as const, doneCount: 1 } : t,
      ),
    };
    mockGet(SCHEDULE, done, { hasAccounts: true });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-lesson-done')).toBeInTheDocument());
    expect(screen.queryByTestId('study-lesson-start')).not.toBeInTheDocument();
  });

  it('v2: без аккаунтов и PGN показывается онбординг-баннер с действиями', async () => {
    mockGet(SCHEDULE, SESSION_V2, { hasAccounts: false, pgnFiles: [] });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-material-banner')).toBeInTheDocument());
    expect(
      screen.getByTestId('study-material-link-accounts').getAttribute('href'),
    ).toBe('/settings?tab=account');
    expect(
      screen.getByTestId('study-material-upload-pgn').getAttribute('href'),
    ).toBe('/workshop/pgn-files');
  });

  it('v2: при привязанном аккаунте баннера нет', async () => {
    mockGet(SCHEDULE, SESSION_V2, { hasAccounts: true });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-lesson-card')).toBeInTheDocument());
    expect(screen.queryByTestId('study-material-banner')).not.toBeInTheDocument();
  });

  it('v2: при загруженном PGN (без аккаунтов) баннера нет', async () => {
    mockGet(SCHEDULE, SESSION_V2, { hasAccounts: false, pgnFiles: [{ id: 'f1' }] });
    wrap();
    await waitFor(() => expect(screen.getByTestId('study-lesson-card')).toBeInTheDocument());
    expect(screen.queryByTestId('study-material-banner')).not.toBeInTheDocument();
  });

  it('findMainLesson: задача lesson с lessonId+courseSlug — main; без них — null', () => {
    expect(findMainLesson(SESSION_V2)?.lessonId).toBe('lesson-uuid-1');
    expect(findMainLesson(SESSION_V2)?.courseSlug).toBe('my-study-course');
    // Задача lesson без params (legacy/сломанные данные) — не main.
    const broken: StudySessionDto = {
      ...SESSION_V2,
      tasks: [makeTask({ id: 'x', type: 'lesson', params: {} })],
    };
    expect(findMainLesson(broken)).toBeNull();
  });

  it('завершённое занятие показывает поздравление', async () => {
    mockGet(SCHEDULE, {
      ...SESSION,
      status: 'completed',
      completedAt: '2026-07-11T20:00:00.000Z',
    });
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-session-completed')).toBeInTheDocument(),
    );
  });
});
