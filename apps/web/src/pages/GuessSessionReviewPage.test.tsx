import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { screen, testI18n } from '../test/test-utils';
import { ThemeProvider } from '../context/ThemeContext';
import { BoardSettingsProvider } from '../context/BoardSettingsContext';
import type {
  GetGuessSessionResponse,
  GuessMoveDto,
  GuessSessionDto,
} from '@kingside/shared';
import { GuessSessionReviewPage } from './GuessSessionReviewPage';

/**
 * KS-3514. Review-страница сессии: метрики + ходы + кнопка в анализ.
 */

const { mockUseAuth, mockNavigate } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(() => ({
    user: { id: 'u1', username: 't' },
    token: 'jwt',
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  })),
  mockNavigate: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

const PGN =
  '[Event "Norway Chess 2026"]\n[White "Carlsen, M"]\n[Black "Nepomniachtchi, I"]\n[Result "*"]\n\n1. e4 e5 *';

function session(
  overrides: Partial<GuessSessionDto> = {},
): GuessSessionDto {
  return {
    id: 's-1',
    gameSource: 'pgn',
    gameRef: null,
    pgn: PGN,
    side: 'white',
    status: 'finished',
    userAccuracy: 80,
    playerAccuracy: 70,
    userStars: 4,
    score: 256,
    bestStreak: 3,
    betterThanPlayerCount: 2,
    startedAt: '2026-05-30T10:00:00.000Z',
    finishedAt: '2026-05-30T10:10:00.000Z',
    ...overrides,
  };
}

const move1: GuessMoveDto = {
  ply: 1,
  fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  playedUci: 'e2e4',
  userUci: 'e2e4',
  bestUci: 'e2e4',
  eBefore: 500,
  eAfterPlayed: 500,
  eAfterUser: 500,
  lossPlayer: 0,
  lossUser: 0,
  accuracyUser: 100,
  accuracyPlayer: 100,
  userClass: 'best',
  verdict: 'strongest',
};

const move3: GuessMoveDto = {
  ply: 3,
  fenBefore:
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  playedUci: 'g1f3',
  userUci: 'b1c3',
  bestUci: 'g1f3',
  eBefore: 500,
  eAfterPlayed: 510,
  eAfterUser: 480,
  lossPlayer: 0,
  lossUser: 30,
  accuracyUser: 78,
  accuracyPlayer: 100,
  userClass: 'inaccuracy',
  verdict: 'weaker',
};

function renderAt(
  path: string,
  response: GetGuessSessionResponse | (() => Promise<GetGuessSessionResponse>),
  toAnalysis?: (id: string) => Promise<{ url: string }>,
  getArchiveGame?: (ref: string) => Promise<{
    white: { name: string | null };
    black: { name: string | null };
    event: string | null;
  }>,
) {
  const getSession = vi
    .fn()
    .mockImplementation(
      typeof response === 'function' ? response : () => Promise.resolve(response),
    );
  render(
    <I18nextProvider i18n={testI18n}>
      <ThemeProvider initialTheme="dark">
        <BoardSettingsProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/guess/sessions/:id"
                element={
                  <GuessSessionReviewPage
                    getSession={getSession}
                    toAnalysis={toAnalysis}
                    getArchiveGame={getArchiveGame}
                  />
                }
              />
            </Routes>
          </MemoryRouter>
        </BoardSettingsProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  return getSession;
}

describe('<GuessSessionReviewPage> KS-3514', () => {
  it('finished: метрики + ходы + кнопка «Open in analysis» активна', async () => {
    mockNavigate.mockReset();
    renderAt('/guess/sessions/s-1', {
      session: session(),
      moves: [move1, move3],
      userPoints: 1,
      playerPoints: 1,
    });
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-page').getAttribute('data-state')).toBe(
        'ready',
      ),
    );
    expect(screen.getByTestId('guess-review-title').textContent).toContain(
      'Carlsen, M',
    );
    expect(screen.getByTestId('guess-review-title').textContent).toContain(
      'Nepomniachtchi, I',
    );
    expect(screen.getByTestId('guess-review-event').textContent).toContain(
      'Norway Chess 2026',
    );
    expect(
      screen.getByTestId('guess-review-metric-your-acc').textContent,
    ).toContain('80%');
    expect(
      screen.getByTestId('guess-review-metric-player-acc').textContent,
    ).toContain('70%');
    expect(
      screen.getByTestId('guess-review-metric-scoreboard').textContent,
    ).toContain('1 : 1');
    expect(
      screen.getByTestId('guess-review-metric-rounds').textContent,
    ).toContain('2');
    // Ход 1 — exact, без скобок с playedSan.
    expect(
      screen.getByTestId('guess-review-move-1').textContent,
    ).toContain('e4');
    // Ход 3 — расхождение: userSan + (playedSan).
    expect(
      screen.getByTestId('guess-review-move-3').textContent,
    ).toContain('Nc3');
    expect(
      screen.getByTestId('guess-review-move-3').textContent,
    ).toContain('Nf3');
    const btn = screen.getByTestId(
      'guess-review-to-analysis',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('active: кнопка «Open in analysis» disabled + title', async () => {
    renderAt('/guess/sessions/s-2', {
      session: session({ id: 's-2', status: 'active', finishedAt: null }),
      moves: [move1],
      userPoints: 1,
      playerPoints: 0,
    });
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-page').getAttribute('data-state')).toBe(
        'ready',
      ),
    );
    const btn = screen.getByTestId(
      'guess-review-to-analysis',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toContain('Finish the session');
    expect(
      screen.getByTestId('guess-review-page').getAttribute('data-status'),
    ).toBe('active');
  });

  it('клик «Open in analysis» → toAnalysis + navigate', async () => {
    const user = userEvent.setup();
    mockNavigate.mockReset();
    const toAnalysis = vi
      .fn()
      .mockResolvedValue({ url: '/analysis/an-77' });
    renderAt(
      '/guess/sessions/s-3',
      {
        session: session({ id: 's-3' }),
        moves: [move1, move3],
        userPoints: 1,
        playerPoints: 1,
      },
      toAnalysis,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-to-analysis')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('guess-review-to-analysis'));
    expect(toAnalysis).toHaveBeenCalledWith('s-3');
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/analysis/an-77'),
    );
  });

  it('error: показывает retry-кнопку', async () => {
    renderAt('/guess/sessions/s-x', () =>
      Promise.reject(new Error('boom')),
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-error')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('guess-review-page').getAttribute('data-state'),
    ).toBe('error');
  });

  it('KS-3516: verdict-метки локализованы (не raw enum)', async () => {
    // Покрываем все 4 verdict'а.
    const verdicts: Array<{
      ply: number;
      verdict: 'strongest' | 'betterThanPlayer' | 'asPlayer' | 'weaker';
      expectedLabel: string;
    }> = [
      { ply: 1, verdict: 'strongest', expectedLabel: 'Strongest' },
      {
        ply: 3,
        verdict: 'betterThanPlayer',
        expectedLabel: 'Better than player',
      },
      { ply: 5, verdict: 'asPlayer', expectedLabel: 'As played' },
      { ply: 7, verdict: 'weaker', expectedLabel: 'Weaker' },
    ];
    renderAt('/guess/sessions/s-loc', {
      session: session({ id: 's-loc' }),
      moves: verdicts.map((v) => ({
        ...move1,
        ply: v.ply,
        verdict: v.verdict,
      })),
      userPoints: 2,
      playerPoints: 1,
    });
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-moves')).toBeInTheDocument(),
    );
    for (const v of verdicts) {
      const el = screen.getByTestId(`guess-review-move-verdict-${v.ply}`);
      expect(el.textContent).toBe(v.expectedLabel);
      // Не должно быть raw enum'а (например, «weaker» или «asPlayer»
      // буквально) — кроме случая asPlayer/'As played' где «As» != «as».
      expect(el.textContent).not.toBe(v.verdict);
    }
  });

  it('KS-3521: PGN без headers + gameSource=archive → подтягиваем имена из архива', async () => {
    const pgnNoHeaders = '1. e4 e5 2. Nf3 *';
    const getArchiveGame = vi.fn().mockResolvedValue({
      white: { name: 'Carlsen, M' },
      black: { name: 'Nepomniachtchi, I' },
      event: 'Norway Chess 2026',
    });
    renderAt(
      '/guess/sessions/s-backfill',
      {
        session: session({
          id: 's-backfill',
          pgn: pgnNoHeaders,
          gameSource: 'archive',
          gameRef: 'arc-77',
        }),
        moves: [],
        userPoints: 0,
        playerPoints: 0,
      },
      undefined,
      getArchiveGame,
    );
    await waitFor(() =>
      expect(getArchiveGame).toHaveBeenCalledWith('arc-77'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-title').textContent).toContain(
        'Carlsen, M',
      ),
    );
    expect(screen.getByTestId('guess-review-title').textContent).toContain(
      'Nepomniachtchi, I',
    );
    expect(
      screen.getByTestId('guess-review-event').textContent,
    ).toContain('Norway Chess 2026');
  });

  it('KS-3521: PGN с «?»-headers тоже триггерит archive-backfill', async () => {
    const pgnQuestion =
      '[Event "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n1. e4 e5 *';
    const getArchiveGame = vi.fn().mockResolvedValue({
      white: { name: 'A' },
      black: { name: 'B' },
      event: 'Test',
    });
    renderAt(
      '/guess/sessions/s-q',
      {
        session: session({
          id: 's-q',
          pgn: pgnQuestion,
          gameSource: 'archive',
          gameRef: 'arc-q',
        }),
        moves: [],
        userPoints: 0,
        playerPoints: 0,
      },
      undefined,
      getArchiveGame,
    );
    await waitFor(() => expect(getArchiveGame).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-title').textContent).toContain(
        'A',
      ),
    );
  });

  it('KS-3521: gameSource=pgn без headers — archive-backfill НЕ вызывается', async () => {
    const getArchiveGame = vi.fn();
    renderAt(
      '/guess/sessions/s-pgn',
      {
        session: session({
          id: 's-pgn',
          pgn: '1. e4 *',
          gameSource: 'pgn',
          gameRef: null,
        }),
        moves: [],
        userPoints: 0,
        playerPoints: 0,
      },
      undefined,
      getArchiveGame,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-review-page').getAttribute('data-state')).toBe(
        'ready',
      ),
    );
    expect(getArchiveGame).not.toHaveBeenCalled();
    // Заголовок остаётся «— vs —».
    expect(screen.getByTestId('guess-review-title').textContent).toContain(
      '— vs —',
    );
  });

  it('KS-3521: ошибка toAnalysis → видимый openError + console.error', async () => {
    const user = userEvent.setup();
    const toAnalysis = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: 400'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderAt(
        '/guess/sessions/s-err',
        {
          session: session({ id: 's-err' }),
          moves: [],
          userPoints: 0,
          playerPoints: 0,
        },
        toAnalysis,
      );
      await waitFor(() =>
        expect(screen.getByTestId('guess-review-to-analysis')).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('guess-review-to-analysis'));
      await waitFor(() =>
        expect(screen.getByTestId('guess-review-open-error')).toBeInTheDocument(),
      );
      expect(
        screen.getByTestId('guess-review-open-error').textContent,
      ).toContain('Bad Request: 400');
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('moves пустые → moves-empty placeholder', async () => {
    renderAt('/guess/sessions/s-4', {
      session: session({ id: 's-4', status: 'active' }),
      moves: [],
      userPoints: 0,
      playerPoints: 0,
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('guess-review-moves-empty'),
      ).toBeInTheDocument(),
    );
  });
});
