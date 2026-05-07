/**
 * KS-2484. Тесты `PrecisionPage` — fetch, рендер карточек,
 * empty / error состояния, навигация на /puzzle/:id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Лёгкая замена Chessboard — иначе react-chessboard тащит много модулей,
// тест медленный и не тематический. Главное — что компонент рендерится.
vi.mock('react-chessboard', () => ({
  Chessboard: ({
    options,
  }: {
    options: { position: string; boardOrientation: string };
  }) => (
    <div
      data-testid="mock-chessboard"
      data-position={options.position}
      data-orientation={options.boardOrientation}
    />
  ),
}));

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

// KS-2545: PrecisionPage теперь использует `useAuth` для gate'а
// stats-блока. Глобально мокаем гостя; в KS-2545-тестах внутри describe
// переопределяем на пользователя через `authValue`.
const authValue: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PrecisionPage } from './PrecisionPage';

const SAMPLE = [
  {
    id: '2dfcd01c-456a-4066-b911-28a32802a6c6',
    fen: '1rb2rk1/3nq1bp/2n1p1p1/ppppPp2/5P2/P1PPBNP1/1P1N1QBP/R4RK1 w - - 2 15',
    rating: 1973,
    themes: ['crushing', 'knightMove', 'playVsEngine'],
    source: 'generated',
    solutionMode: 'play-vs-engine',
    playVsEngine: {
      blunderMove: 'a8b8',
      wdlAfterBlunder: 0.958,
      winThreshold: 0.5,
      failThreshold: 0,
      halfMovesN: 6,
    },
  },
  {
    id: 'bc940cc2-15ab-4fc9-bf06-feaf114f2a28',
    fen: '1r3bk1/1r2q2p/b3p1p1/p1npPp2/2pB1P2/P1P3PP/1P1R1QBN/4R1K1 b - - 2 23',
    rating: 1991,
    themes: ['crushing', 'playVsEngine', 'rookMove'],
    source: 'generated',
    solutionMode: 'play-vs-engine',
  },
];

beforeEach(() => {
  apiGet.mockReset();
  mockNavigate.mockReset();
  authValue.user = null;
});

afterEach(() => vi.restoreAllMocks());

describe('<PrecisionPage> KS-2484', () => {
  it('fetch /puzzles?solutionMode=play-vs-engine&limit=20 при mount', async () => {
    apiGet.mockResolvedValueOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(apiGet).toHaveBeenCalledWith(
      '/puzzles?solutionMode=play-vs-engine&limit=20',
    );
  });

  it('рендерит карточки на каждый пазл с FEN, рейтингом, темами', async () => {
    apiGet.mockResolvedValueOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    const cards = screen.getAllByTestId('play-vs-engine-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-puzzle-id')).toBe(SAMPLE[0].id);
    // FEN пробрасывается в Chessboard.
    const boards = screen.getAllByTestId('mock-chessboard');
    expect(boards[0].getAttribute('data-position')).toBe(SAMPLE[0].fen);
    // Ориентация по side-to-move: SAMPLE[1].fen — 'b' → black внизу.
    expect(boards[1].getAttribute('data-orientation')).toBe('black');
    // Рейтинг видим.
    const ratings = screen.getAllByTestId('play-vs-engine-card-rating');
    expect(ratings[0].textContent).toMatch(/1973/);
    // Темы (≤3 первых).
    const themes = screen
      .getAllByTestId('play-vs-engine-card-theme')
      .map((n) => n.textContent);
    expect(themes.length).toBeGreaterThan(0);
  });

  it('KS-2547: клик по «Solve» навигирует на /puzzle/:id?source=precision', async () => {
    apiGet.mockResolvedValueOnce(SAMPLE);
    const user = userEvent.setup();
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    await user.click(screen.getAllByTestId('play-vs-engine-card-solve')[0]);
    expect(mockNavigate).toHaveBeenCalledWith(
      `/puzzle/${SAMPLE[0].id}?source=precision`,
    );
  });

  it('пустой ответ → empty state с плейсхолдером', async () => {
    apiGet.mockResolvedValueOnce([]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('empty'),
    );
    expect(screen.getByTestId('play-vs-engine-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('play-vs-engine-card')).toHaveLength(0);
  });

  it('ошибка API → error state с retry-кнопкой', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('error'),
    );
    expect(screen.getByTestId('play-vs-engine-error')).toBeInTheDocument();
    // Retry → новый запрос.
    apiGet.mockResolvedValueOnce(SAMPLE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retry|повторить/i }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
  });

  it('гость (user=null) → stats-блок НЕ рендерится', async () => {
    apiGet.mockResolvedValueOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    expect(screen.queryByTestId('precision-stats')).toBeNull();
  });
});

describe('<PrecisionPage> KS-2545 — stats-блок', () => {
  it('рендерит totalAttempted/totalSolved/lastAttemptAt из API', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    // Маршрутизация по URL: puzzles list, stats/me, attempts list.
    apiGet.mockImplementation((url: string) => {
      if (url === '/puzzles?solutionMode=play-vs-engine&limit=20') {
        return Promise.resolve(SAMPLE);
      }
      if (url === '/puzzles/stats/me') {
        return Promise.resolve({
          byMode: {
            'forced-line': {
              attempts: 30,
              solved: 20,
              accuracy: 67,
              avgRating: 1500,
              avgTimeMs: 12000,
            },
            'play-vs-engine': {
              attempts: 12,
              solved: 7,
              accuracy: 58,
              avgRating: 1980,
              avgTimeMs: 32000,
            },
          },
        });
      }
      if (url === '/puzzles/attempts?take=20&skip=0') {
        return Promise.resolve([
          // Свежий attempt forced-line — должны его пропустить.
          {
            createdAt: '2026-05-06T10:00:00Z',
            puzzle: { solutionMode: 'forced-line' },
          },
          // Первый PvE — он и должен быть «последним».
          {
            createdAt: '2026-05-05T15:00:00Z',
            puzzle: { solutionMode: 'play-vs-engine' },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    expect(block.getAttribute('data-attempts')).toBe('12');
    expect(block.getAttribute('data-solved')).toBe('7');
    expect(
      screen.getByTestId('precision-stats-attempted').textContent,
    ).toMatch(/12/);
    expect(screen.getByTestId('precision-stats-solved').textContent).toMatch(
      /7/,
    );
    // lastAttemptAt — рендерится через `toLocaleDateString`, проверяем
    // что это не «—» (значит дата подставилась).
    const lastEl = screen.getByTestId('precision-stats-last-attempt');
    expect(lastEl.textContent).not.toMatch(/—/);
  });

  it('user без play-vs-engine attempts → lastAttemptAt = «—»', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url === '/puzzles?solutionMode=play-vs-engine&limit=20') {
        return Promise.resolve([]);
      }
      if (url === '/puzzles/stats/me') {
        return Promise.resolve({
          byMode: {
            'forced-line': {
              attempts: 5,
              solved: 4,
              accuracy: 80,
              avgRating: 1500,
              avgTimeMs: 10000,
            },
            'play-vs-engine': {
              attempts: 0,
              solved: 0,
              accuracy: 0,
              avgRating: null,
              avgTimeMs: 0,
            },
          },
        });
      }
      if (url === '/puzzles/attempts?take=20&skip=0') {
        return Promise.resolve([
          {
            createdAt: '2026-05-06T10:00:00Z',
            puzzle: { solutionMode: 'forced-line' },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    expect(block.getAttribute('data-attempts')).toBe('0');
    expect(block.getAttribute('data-solved')).toBe('0');
    expect(
      screen.getByTestId('precision-stats-last-attempt').textContent,
    ).toMatch(/—/);
  });

  it('stats/me падает → блок рендерится с нулями (graceful)', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url === '/puzzles?solutionMode=play-vs-engine&limit=20') {
        return Promise.resolve(SAMPLE);
      }
      if (url === '/puzzles/stats/me') {
        return Promise.reject(new Error('500'));
      }
      if (url === '/puzzles/attempts?take=20&skip=0') {
        return Promise.reject(new Error('500'));
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    // Оба запроса упали через `.catch` → fetchStats положил нули.
    expect(block.getAttribute('data-attempts')).toBe('0');
    expect(block.getAttribute('data-solved')).toBe('0');
    expect(
      screen.getByTestId('precision-stats-last-attempt').textContent,
    ).toMatch(/—/);
  });
});
