/**
 * KS-4195: regression-тест на гостевой рендер карточки публичной
 * лекции. Backend `/lectures/public` (KS-4188) на проде сейчас не
 * отдаёт поле `coach` — старый код читал `lecture.coach.username`
 * без guard и валил всю страницу `/lectures` для неавторизованного.
 *
 * Контракты:
 *  1) Карточка с `coach=undefined` рендерится без исключения и без
 *     ссылки на `/coach/:username`.
 *  2) Карточка с заполненным `coach` рендерит ссылку
 *     `/coach/<username>` и имя тренера.
 */
import { describe, it, expect, vi } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PublicLectureCard } from './PublicLectureCard';
import type { PublicLecture } from '../../api/publicLectures';

// Chessboard тянет тяжёлый SVG-рендер и обращается к DOM-API, которых
// нет в happy-dom. Для unit-теста карточки достаточно проверить, что
// препейс-доска рендерится как placeholder.
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard-stub" />,
}));

const BASE_LECTURE: PublicLecture = {
  id: 'lec-1',
  title: 'Endgame fundamentals',
  description: 'Pawn endings and basic king activity.',
  status: 'recorded',
  scheduledAt: null,
  startedAt: '2026-06-10T15:35:37.492Z',
  endedAt: '2026-06-10T15:37:45.201Z',
  durationMs: 130_000,
  previewFen: null,
};

describe('PublicLectureCard', () => {
  it('renders without crashing when coach is missing (guest catalog regression)', () => {
    // Гарантируем отсутствие токена — гостевой сценарий.
    localStorage.removeItem('token');

    expect(() =>
      renderWithProviders(<PublicLectureCard lecture={BASE_LECTURE} />),
    ).not.toThrow();

    // Сам контент карточки на месте.
    expect(screen.getByText('Endgame fundamentals')).toBeInTheDocument();

    // Никаких ссылок на /coach/:username, имя тренера в DOM не появляется.
    const coachLink = screen.queryByRole('link', { name: /coach/i });
    expect(coachLink).toBeNull();
    expect(document.querySelector('.public-lecture-card__coach')).toBeNull();
  });

  it('renders coach link when coach.username is present', () => {
    renderWithProviders(
      <PublicLectureCard
        lecture={{
          ...BASE_LECTURE,
          coach: { username: 'magnus', country: 'NO' },
        }}
      />,
    );

    const coachLink = screen.getByRole('link', { name: 'magnus' });
    expect(coachLink).toBeInTheDocument();
    expect(coachLink).toHaveAttribute('href', '/coach/magnus');
  });
});
