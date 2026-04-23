import { describe, it, expect } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { TeamStandings } from './TeamStandings';
import type { CrosstableTeam, CrosstablePlayer } from '@kingside/shared';

/**
 * KS-1739 / ADR-023 §2.11 (A15) — unit-тесты team-standings.
 * Две фикстуры (Bundesliga-like, WTCC-like), expand/collapse состава,
 * нет сброса expand у соседних команд при переключении одной.
 */

function player(
  overrides: Partial<CrosstablePlayer> & Pick<CrosstablePlayer, 'rank' | 'name' | 'team'>,
): CrosstablePlayer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    points: 0,
    gamesPlayed: 0,
    ...overrides,
  };
}

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/x',
  fetchedAt: '2026-04-23T10:00:00.000Z',
} satisfies Pick<CrosstableTeam, 'sourceType' | 'sourceUrl' | 'fetchedAt'>;

describe('<TeamStandings>', () => {
  it('Bundesliga-фикстура: рендерит таблицу команд без раскрытия', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-round-robin',
      teams: [
        { name: 'Baden-Baden', rank: 1, points: 15 },
        { name: 'Solingen', rank: 2, points: 12 },
        { name: 'Werder Bremen', rank: 3, points: 9 },
      ],
      players: [
        player({ rank: 1, name: 'Anand', team: 'Baden-Baden', elo: 2750, points: 5 }),
        player({ rank: 2, name: 'Caruana', team: 'Baden-Baden', elo: 2780, points: 4.5 }),
        player({ rank: 3, name: 'Giri', team: 'Solingen', elo: 2770, points: 4 }),
        player({ rank: 4, name: 'Nakamura', team: 'Solingen', elo: 2790, points: 3.5 }),
      ],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);

    expect(screen.getByTestId('team-standings')).toBeInTheDocument();
    expect(screen.getByText('Baden-Baden')).toBeInTheDocument();
    expect(screen.getByText('Solingen')).toBeInTheDocument();
    // По умолчанию — никакой команды не раскрыто
    expect(screen.queryByTestId('team-members-Baden-Baden')).toBeNull();
    expect(screen.queryByTestId('team-members-Solingen')).toBeNull();
  });

  it('клик по toggle раскрывает состав команды; повторный клик — сворачивает', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-swiss',
      teams: [{ name: 'Red', rank: 1, points: 5 }],
      players: [
        player({ rank: 1, name: 'Alice', team: 'Red', elo: 2500, points: 3 }),
        player({ rank: 2, name: 'Bob', team: 'Red', elo: 2400, points: 2 }),
      ],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);

    const toggle = screen.getByTestId('team-toggle-Red');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('team-members-Red')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('team-members-Red')).toBeNull();
  });

  it('раскрытие одной команды не влияет на состояние других', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-swiss',
      teams: [
        { name: 'A', rank: 1, points: 3 },
        { name: 'B', rank: 2, points: 2 },
      ],
      players: [
        player({ rank: 1, name: 'A1', team: 'A' }),
        player({ rank: 2, name: 'B1', team: 'B' }),
      ],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);

    fireEvent.click(screen.getByTestId('team-toggle-A'));
    expect(screen.getByTestId('team-members-A')).toBeInTheDocument();
    expect(screen.queryByTestId('team-members-B')).toBeNull();

    fireEvent.click(screen.getByTestId('team-toggle-B'));
    expect(screen.getByTestId('team-members-A')).toBeInTheDocument();
    expect(screen.getByTestId('team-members-B')).toBeInTheDocument();
  });

  it('игроки команды сортируются по rank (board 1 первый)', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-round-robin',
      teams: [{ name: 'Red', rank: 1, points: 5 }],
      players: [
        player({ rank: 3, name: 'Third', team: 'Red' }),
        player({ rank: 1, name: 'First', team: 'Red' }),
        player({ rank: 2, name: 'Second', team: 'Red' }),
      ],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);
    fireEvent.click(screen.getByTestId('team-toggle-Red'));
    const members = screen.getByTestId('team-members-Red');
    const rows = members.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('First');
    expect(rows[1].textContent).toContain('Second');
    expect(rows[2].textContent).toContain('Third');
  });

  it('toggle не рендерится для команды без игроков', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-swiss',
      teams: [{ name: 'Lonely', rank: 1, points: 0 }],
      players: [],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);
    expect(screen.queryByTestId('team-toggle-Lonely')).toBeNull();
  });

  it('возвращает empty-state при teams=[]', () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-swiss',
      teams: [],
      players: [],
    };
    renderWithProviders(<TeamStandings data={data} broadcastId="b1" />);
    expect(screen.getByTestId('team-standings-empty')).toBeInTheDocument();
  });
});
