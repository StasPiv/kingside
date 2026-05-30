import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { GuessSessionRunner } from './GuessSessionRunner';
import type {
  GuessMoveDto,
  GuessSessionDto,
  StartGuessSessionResponse,
  SubmitGuessMoveResponse,
  FinishGuessSessionResponse,
} from '@kingside/shared';

/**
 * KS-3411 (ADR-086 §9, F2) — сессия + HUD + финал-экран (server-trust).
 * guessApi и GuessRunner (F1) замоканы: проверяем wiring start/move/finish
 * и отображение СЕРВЕРНЫХ значений (score/streak/better/accuracy).
 */

// KS-3458: SessionRunner вызывает useAuth() для имени пользователя в
// HUD. В тест-обвязке AuthProvider не смонтирован — стабим, чтобы
// возвращалось предсказуемое значение (для PGN без headers playerLabel
// = null, для user=null userLabel = null → fallback на старые i18n).
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

const startSession = vi.fn();
const submitMove = vi.fn();
const finishSession = vi.fn();
vi.mock('../../api/guessApi', () => ({
  guessApi: {
    startSession: (...a: unknown[]) => startSession(...a),
    submitMove: (...a: unknown[]) => submitMove(...a),
    finishSession: (...a: unknown[]) => finishSession(...a),
  },
  GUESS_VERDICT_POINTS: { strongest: 10, betterThanPlayer: 7, asPlayer: 5, weaker: 1 },
}));

// GuessRunner (F1) — стаб с кнопками, дёргающими onGuess/onFinish.
vi.mock('./GuessRunner', () => ({
  GuessRunner: ({
    onGuess,
    onFinish,
  }: {
    onGuess?: (s: unknown) => void;
    onFinish?: () => void;
  }) => (
    <div data-testid="runner-stub">
      <button
        type="button"
        data-testid="fire-guess"
        onClick={() =>
          onGuess?.({
            ply: 1,
            fenBefore: 'startfen',
            playedUci: 'e2e4',
            userUci: 'd2d4',
            bestUci: 'e2e4',
            wdlBefore: { w: 500, d: 300, l: 200 },
            wdlAfterPlayed: { w: 300, d: 300, l: 400 },
            wdlAfterUser: { w: 350, d: 300, l: 350 },
            comparison: {} as never,
          })
        }
      >
        guess
      </button>
      <button type="button" data-testid="fire-finish" onClick={() => onFinish?.()}>
        finish
      </button>
    </div>
  ),
}));

function session(over: Partial<GuessSessionDto> = {}): GuessSessionDto {
  return {
    id: 's-1',
    gameSource: 'pgn',
    gameRef: null,
    side: 'white',
    status: 'active',
    userAccuracy: null,
    playerAccuracy: null,
    userStars: null,
    score: 0,
    bestStreak: 0,
    betterThanPlayerCount: 0,
    startedAt: '2026-05-29T00:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

function moveDto(over: Partial<GuessMoveDto> = {}): GuessMoveDto {
  return {
    ply: 1,
    fenBefore: 'startfen',
    playedUci: 'e2e4',
    userUci: 'd2d4',
    bestUci: 'e2e4',
    eBefore: 0.65,
    eAfterPlayed: 0.55,
    eAfterUser: 0.5,
    lossPlayer: 0.1,
    lossUser: 0.15,
    accuracyUser: 80,
    accuracyPlayer: 90,
    userClass: 'good',
    verdict: 'weaker',
    ...over,
  };
}

const PGN = '1. e4 e5 *';
const PGN_WITH_HEADERS =
  '[Event "Test"]\n[White "Carlsen, Magnus"]\n[Black "Gukesh D"]\n[WhiteElo "2828"]\n[BlackElo "2783"]\n\n1. e4 e5 *';

beforeEach(() => {
  startSession.mockReset();
  submitMove.mockReset();
  finishSession.mockReset();
});

describe('<GuessSessionRunner> KS-3411', () => {
  it('старт → playing, HUD-точности «—» до первого хода (KS-3430)', async () => {
    startSession.mockResolvedValue({ session: session({ score: 0 }) } as StartGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('playing'),
    );
    // KS-3436: HUD теперь табло «ты : игрок»; до первого хода 0:0.
    expect(screen.getByTestId('guess-hud-user-points').textContent).toBe('0');
    expect(screen.getByTestId('guess-hud-player-points').textContent).toBe('0');
  });

  it('старт упал → error', async () => {
    startSession.mockRejectedValue(new Error('404'));
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('error'),
    );
    expect(screen.getByTestId('guess-session-error')).toBeTruthy();
  });

  it('guess → submitMove, HUD-табло обновляется серверными userPoints/playerPoints (KS-3436)', async () => {
    startSession.mockResolvedValue({ session: session() } as StartGuessSessionResponse);
    submitMove.mockResolvedValue({
      move: moveDto(),
      score: 7,
      currentStreak: 1,
      betterThanPlayerCount: 2,
      currentUserAccuracy: 72.6,
      currentPlayerAccuracy: 91.4,
      userPoints: 2,
      playerPoints: 1,
    } as SubmitGuessMoveResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('playing'),
    );
    (screen.getByTestId('fire-guess') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('guess-hud-user-points').textContent).toBe('2'),
    );
    expect(screen.getByTestId('guess-hud-player-points').textContent).toBe('1');
    // submitMove получил RAW WDL как есть.
    expect(submitMove).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({
        playedUci: 'e2e4',
        userUci: 'd2d4',
        wdlAfterPlayed: { w: 300, d: 300, l: 400 },
        wdlAfterUser: { w: 350, d: 300, l: 350 },
      }),
    );
  });

  it('finish → finishSession, финал-экран с серверными точностями/звёздами/исходом + список ходов', async () => {
    startSession.mockResolvedValue({ session: session() } as StartGuessSessionResponse);
    submitMove.mockResolvedValue({
      move: moveDto({ ply: 1, verdict: 'weaker', userClass: 'mistake' }),
      score: 1,
      currentStreak: 0,
      betterThanPlayerCount: 0,
    } as SubmitGuessMoveResponse);
    finishSession.mockResolvedValue({
      session: session({
        status: 'finished',
        userAccuracy: 72,
        playerAccuracy: 88,
        userStars: 3,
        score: 1,
        bestStreak: 1,
        betterThanPlayerCount: 0,
      }),
      outcome: 'playerBetter',
    } as FinishGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('playing'),
    );
    (screen.getByTestId('fire-guess') as HTMLButtonElement).click();
    await waitFor(() => expect(submitMove).toHaveBeenCalled());
    (screen.getByTestId('fire-finish') as HTMLButtonElement).click();
    await waitFor(() => expect(screen.getByTestId('guess-final')).toBeTruthy());
    expect(screen.getByTestId('guess-final-user-accuracy').textContent).toContain('72%');
    expect(screen.getByTestId('guess-final-player-accuracy').textContent).toContain('88%');
    expect(screen.getByTestId('guess-final-user-stars').textContent).toContain('★');
    expect(screen.getByTestId('guess-final-outcome')).toBeTruthy();
    // Список ходов из накопленных серверных move-DTO.
    expect(screen.getByTestId('guess-final-move-1').getAttribute('data-verdict')).toBe('weaker');
  });

  it('KS-3458: HUD-лейблы — fallback на «You/Game» если PGN без headers и user=null', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe(
        'playing',
      ),
    );
    expect(screen.getByTestId('guess-hud-user-label').textContent).toBe('You');
    expect(screen.getByTestId('guess-hud-player-label').textContent).toBe('Game');
  });

  it('KS-3458: HUD-лейблы — PGN с headers (side=white) → «Carlsen, Magnus 2828»', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN_WITH_HEADERS} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe(
        'playing',
      ),
    );
    expect(screen.getByTestId('guess-hud-player-label').textContent).toBe(
      'Carlsen, Magnus 2828',
    );
  });

  it('KS-3458: HUD-лейблы — side=black → Black player', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN_WITH_HEADERS} side="black" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe(
        'playing',
      ),
    );
    expect(screen.getByTestId('guess-hud-player-label').textContent).toBe(
      'Gukesh D 2783',
    );
  });
});
