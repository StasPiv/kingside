/**
 * KS-4195/KS-4199: тесты гостевой карточки публичной лекции.
 *
 * Backend `/lectures/public` (KS-4188/KS-4197) возвращает
 * `coach: { id, username } | null`, причём `username` тоже nullable —
 * у тренера может быть `requiresUsernameSetup=true`.
 *
 * Покрываем три ветки рендера:
 *  1) `coach: { username: 'magnus' }` — ссылка `/coach/magnus` и имя.
 *  2) `coach: { username: null }` — fallback «Unnamed coach» без ссылки.
 *  3) `coach: null` — строки тренера нет совсем.
 */
import { describe, it, expect, vi } from 'vitest';

import type { PublicLecture } from '../../api/publicLectures';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PublicLectureCard } from './PublicLectureCard';

// Chessboard тянет тяжёлый SVG-рендер и обращается к DOM-API, которых
// нет в happy-dom. Для unit-теста карточки достаточно проверить, что
// препейс-доска рендерится как placeholder.
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard-stub" />,
}));

function makeLecture(overrides: Partial<PublicLecture> = {}): PublicLecture {
  return {
    id: 'lec-1',
    ownerId: 'user-1',
    title: 'Endgame fundamentals',
    description: 'Pawn endings and basic king activity.',
    scheduledAt: null,
    startedAt: '2026-06-10T15:35:37.492Z',
    endedAt: '2026-06-10T15:37:45.201Z',
    durationMs: 130_000,
    status: 'recorded',
    visibility: 'public',
    liveAnalysisId: null,
    recordingId: 'rec-1',
    mediaUrl: null,
    mediaKind: null,
    createdAt: '2026-06-10T15:30:00.000Z',
    updatedAt: '2026-06-10T15:40:00.000Z',
    liveAnalysis: null,
    disabledTools: [],
    hideMetricsTab: false,
    coach: { id: 'coach-1', username: 'magnus' },
    ...overrides,
  };
}

describe('PublicLectureCard', () => {
  it('renders coach link when coach.username is present (KS-4199)', () => {
    renderWithProviders(<PublicLectureCard lecture={makeLecture()} />);

    const coachLink = screen.getByRole('link', { name: 'magnus' });
    expect(coachLink).toBeInTheDocument();
    expect(coachLink).toHaveAttribute('href', '/coach/magnus');
  });

  it('renders fallback name when coach.username is null (KS-4199)', () => {
    renderWithProviders(
      <PublicLectureCard
        lecture={makeLecture({ coach: { id: 'coach-2', username: null } })}
      />,
    );

    // Никаких ссылок на /coach/* в карточке.
    expect(
      document.querySelector('a.public-lecture-card__coach'),
    ).toBeNull();
    // Зато fallback-имя отображается.
    expect(
      screen.getByTestId('public-lecture-card-coach-nameless'),
    ).toBeInTheDocument();
  });

  it('omits coach row entirely when coach is null (KS-4195 regression)', () => {
    // Гарантируем отсутствие токена — гостевой сценарий.
    localStorage.removeItem('token');

    expect(() =>
      renderWithProviders(
        <PublicLectureCard lecture={makeLecture({ coach: null })} />,
      ),
    ).not.toThrow();

    expect(screen.getByText('Endgame fundamentals')).toBeInTheDocument();
    expect(document.querySelector('.public-lecture-card__coach')).toBeNull();
    expect(
      screen.queryByTestId('public-lecture-card-coach-nameless'),
    ).toBeNull();
  });
});
