import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { RoundRobinCrosstable, lastNameOnly } from './RoundRobinCrosstable';
import type { CrosstableRoundRobin, CrosstablePlayer, CrosstableCell } from '@kingside/shared';

/**
 * KS-1737 / ADR-023 §2.11 (A13) — unit-тесты матрицы N×N round-robin.
 * Проверяют рендер шапки, заполнение матрицы, кликабельность через
 * mock `useNavigate`, обработку bye и ненабранной партии.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

beforeEach(() => {
  mockNavigate.mockReset();
});

function player(overrides: Partial<CrosstablePlayer> & Pick<CrosstablePlayer, 'rank' | 'name'>): CrosstablePlayer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    points: 0,
    gamesPlayed: 0,
    ...overrides,
  };
}

function win(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'win', color: 'white', opponentRank: 0, gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'win', color: 'white' };
}

function loss(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'loss', color: 'black', gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'loss', color: 'black' };
}

function draw(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'draw', gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'draw' };
}

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/tnr1',
  fetchedAt: '2026-04-23T10:00:00.000Z',
} satisfies Pick<CrosstableRoundRobin, 'sourceType' | 'sourceUrl' | 'fetchedAt'>;

describe('<RoundRobinCrosstable>', () => {
  it('рендерит 2×2 матрицу с диагональю ✕', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice', points: 1, gamesPlayed: 1 }),
        player({ rank: 2, name: 'Bob', points: 0, gamesPlayed: 1 }),
      ],
      matrix: [
        [{ result: null }, win('g1')],
        [loss('g1'), { result: null }],
      ],
    };

    const { container } = renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b1" />);

    expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Диагональные ячейки
    expect(screen.getAllByText('✕').length).toBe(2);
    // Результаты: по CSS-классу выигранной/проигранной ячейки
    expect(container.querySelector('.broadcast-xt-cell--win')).toHaveTextContent('1');
    expect(container.querySelector('.broadcast-xt-cell--loss')).toHaveTextContent('0');
  });

  it('на клик по ячейке с gameRef вызывает navigate с правильным путём', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice' }),
        player({ rank: 2, name: 'Bob' }),
      ],
      matrix: [
        [{ result: null }, win('game-xyz')],
        [loss('game-xyz'), { result: null }],
      ],
    };

    const { container } = renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b42" />);

    const clickable = container.querySelector('.broadcast-xt-cell--win')!;
    expect(clickable).toHaveClass('broadcast-xt-cell--clickable');
    fireEvent.click(clickable);
    expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/b42/r-game-xyz/game-xyz');
  });

  it('ячейка без gameRef не получает класс --clickable и не вызывает navigate', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice' }),
        player({ rank: 2, name: 'Bob' }),
      ],
      matrix: [
        [{ result: null }, draw()],
        [draw(), { result: null }],
      ],
    };

    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b1" />);

    const drawCells = screen.getAllByText('½');
    for (const el of drawCells) {
      const td = el.closest('td')!;
      expect(td).not.toHaveClass('broadcast-xt-cell--clickable');
    }
    fireEvent.click(drawCells[0].closest('td')!);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('bye рендерится символом * (из chess-results)', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'A' }),
        player({ rank: 2, name: 'B' }),
      ],
      matrix: [
        [{ result: null }, { result: 'bye' }],
        [{ result: null }, { result: null }],
      ],
    };
    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('рендерит 8 игроков с tiebreak-ами и title-ами', () => {
    const players: CrosstablePlayer[] = Array.from({ length: 8 }, (_, i) =>
      player({
        rank: i + 1,
        name: `P${i + 1}`,
        federation: 'FID',
        elo: 2500 + i,
        title: i === 0 ? 'GM' : undefined,
        points: 7 - i,
        gamesPlayed: 7,
        tiebreaks: { sonnebornBerger: i + 1 },
      }),
    );
    const matrix: CrosstableCell[][] = Array.from({ length: 8 }, (_, ri) =>
      Array.from({ length: 8 }, (_, ci) => {
        if (ri === ci) return { result: null };
        if (ri < ci) return win(`g-${ri}-${ci}`);
        return loss(`g-${ci}-${ri}`);
      }),
    );
    const data: CrosstableRoundRobin = { ...BASE, tournamentType: 'round-robin', players, matrix };

    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="x" />);

    expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument();
    expect(screen.getByText('GM')).toBeInTheDocument();
    // 8 игроков → 8 диагональных ✕
    expect(screen.getAllByText('✕').length).toBe(8);
    // tiebreak-колонка «SB»
    expect(screen.getByText('SB')).toBeInTheDocument();
  });

  // KS-2478: double / multi-RR — ячейка с массивом cell.games[].
  describe('KS-2478 — double-RR cell.games[]', () => {
    it('cell.games (2 встречи) → рендерит обе с раздельными data-color/data-result + раздельные ссылки', () => {
      const data: CrosstableRoundRobin = {
        ...BASE,
        tournamentType: 'round-robin',
        players: [
          player({ rank: 1, name: 'Alice', points: 1.5, gamesPlayed: 2 }),
          player({ rank: 2, name: 'Bob', points: 0.5, gamesPlayed: 2 }),
        ],
        matrix: [
          [
            { result: null },
            {
              // top-level — последняя партия (back-compat)
              result: 'draw',
              color: 'black',
              gameRef: { gameId: 'g2', roundId: 'r-g2', roundName: 'R14' },
              games: [
                {
                  result: 'win',
                  color: 'white',
                  gameRef: { gameId: 'g1', roundId: 'r-g1', roundName: 'R1' },
                },
                {
                  result: 'draw',
                  color: 'black',
                  gameRef: { gameId: 'g2', roundId: 'r-g2', roundName: 'R14' },
                },
              ],
            },
          ],
          [
            {
              result: 'draw',
              color: 'white',
              gameRef: { gameId: 'g2', roundId: 'r-g2', roundName: 'R14' },
              games: [
                {
                  result: 'loss',
                  color: 'black',
                  gameRef: { gameId: 'g1', roundId: 'r-g1', roundName: 'R1' },
                },
                {
                  result: 'draw',
                  color: 'white',
                  gameRef: { gameId: 'g2', roundId: 'r-g2', roundName: 'R14' },
                },
              ],
            },
            { result: null },
          ],
        ],
      };

      renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b1" />);

      // У строки Alice есть multi-cell.
      const multiCells = screen.getAllByTestId('broadcast-xt-cell-multi');
      expect(multiCells.length).toBeGreaterThanOrEqual(1);
      // В первой multi-cell два значка с разными цветами.
      const game0 = screen.getAllByTestId('broadcast-xt-cell-game-0')[0];
      const game1 = screen.getAllByTestId('broadcast-xt-cell-game-1')[0];
      expect(game0.getAttribute('data-color')).toBe('white');
      expect(game0.getAttribute('data-result')).toBe('win');
      expect(game1.getAttribute('data-color')).toBe('black');
      expect(game1.getAttribute('data-result')).toBe('draw');
      // Текстовые символы — «1» и «½».
      expect(game0.textContent).toContain('1');
      expect(game1.textContent).toContain('½');
      // Клик по первому значку — навигация на g1.
      fireEvent.click(game0);
      expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/b1/r-g1/g1');
      // Клик по второму — на g2.
      mockNavigate.mockClear();
      fireEvent.click(game1);
      expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/b1/r-g2/g2');
    });

    it('cell без games[] (single-RR) → старый рендер с top-level result/gameRef', () => {
      const data: CrosstableRoundRobin = {
        ...BASE,
        tournamentType: 'round-robin',
        players: [
          player({ rank: 1, name: 'Alice', points: 1, gamesPlayed: 1 }),
          player({ rank: 2, name: 'Bob', points: 0, gamesPlayed: 1 }),
        ],
        matrix: [
          [{ result: null }, win('only-game')],
          [loss('only-game'), { result: null }],
        ],
      };
      renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
      // Multi-cell не появляется.
      expect(screen.queryByTestId('broadcast-xt-cell-multi')).not.toBeInTheDocument();
      // Старая single-result ячейка кликабельна.
      const winCell = document.querySelector('.broadcast-xt-cell--win')!;
      expect(winCell).toHaveClass('broadcast-xt-cell--clickable');
      fireEvent.click(winCell);
      expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/b/r-only-game/only-game');
    });

    it('cell.games длины 1 → одиночный рендер (не multi-mode)', () => {
      // Backend rev:40 не должен такое отдавать (filter ≥2), но
      // защищаемся от регрессий single-RR.
      const data: CrosstableRoundRobin = {
        ...BASE,
        tournamentType: 'round-robin',
        players: [
          player({ rank: 1, name: 'A', points: 1, gamesPlayed: 1 }),
          player({ rank: 2, name: 'B', points: 0, gamesPlayed: 1 }),
        ],
        matrix: [
          [
            { result: null },
            {
              result: 'win',
              color: 'white',
              gameRef: { gameId: 'g1', roundId: 'r-g1', roundName: 'R1' },
              games: [
                {
                  result: 'win',
                  color: 'white',
                  gameRef: { gameId: 'g1', roundId: 'r-g1', roundName: 'R1' },
                },
              ],
            },
          ],
          [{ result: null }, { result: null }],
        ],
      };
      renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
      expect(screen.queryByTestId('broadcast-xt-cell-multi')).not.toBeInTheDocument();
      // Top-level result рендерится по-старому.
      expect(document.querySelector('.broadcast-xt-cell--win')).toHaveTextContent('1');
    });
  });

  describe('KS-3539: только фамилия в колонке игрока', () => {
    it('lastNameOnly: «So, Wesley» → «So»', () => {
      expect(lastNameOnly('So, Wesley')).toBe('So');
      expect(lastNameOnly('Carlsen, Magnus')).toBe('Carlsen');
      expect(lastNameOnly('Nepomniachtchi, Ian')).toBe('Nepomniachtchi');
    });

    it('lastNameOnly: без запятой — возвращает как есть', () => {
      expect(lastNameOnly('Praggnanandhaa R')).toBe('Praggnanandhaa R');
      expect(lastNameOnly('Magnus Carlsen')).toBe('Magnus Carlsen');
    });

    it('lastNameOnly: пустая часть до запятой — fallback на полный name', () => {
      expect(lastNameOnly(', Wesley')).toBe(', Wesley');
    });

    it('рендер: в td-name выводится только фамилия, title=полное имя', () => {
      const data: CrosstableRoundRobin = {
        ...BASE,
        tournamentType: 'round-robin',
        players: [
          player({ rank: 1, name: 'So, Wesley', points: 1, gamesPlayed: 1 }),
          player({ rank: 2, name: 'Carlsen, Magnus', points: 0, gamesPlayed: 1 }),
        ],
        matrix: [
          [{ result: 'bye' as const }, win('g1')],
          [{ result: 'loss' as const }, { result: 'bye' as const }],
        ],
      };
      const { container } = renderWithProviders(
        <RoundRobinCrosstable data={data} broadcastId="b" />,
      );
      const nameCells = container.querySelectorAll<HTMLTableCellElement>(
        '.broadcast-xt-td-name',
      );
      expect(nameCells[0].textContent).toContain('So');
      expect(nameCells[0].textContent).not.toContain('Wesley');
      expect(nameCells[0].getAttribute('title')).toBe('So, Wesley');
      expect(nameCells[1].textContent).toContain('Carlsen');
      expect(nameCells[1].textContent).not.toContain('Magnus');
      expect(nameCells[1].getAttribute('title')).toBe('Carlsen, Magnus');
    });
  });

  it('возвращает empty-state при пустом players[]', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [],
      matrix: [],
    };
    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
    expect(screen.getByTestId('round-robin-crosstable-empty')).toBeInTheDocument();
  });
});
