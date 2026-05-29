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

beforeEach(() => {
  startSession.mockReset();
  submitMove.mockReset();
  finishSession.mockReset();
});

describe('<GuessSessionRunner> KS-3411', () => {
  it('старт → playing, HUD из серверной сессии', async () => {
    startSession.mockResolvedValue({ session: session({ score: 0 }) } as StartGuessSessionResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('playing'),
    );
    expect(screen.getByTestId('guess-hud-score').textContent).toContain('0');
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

  it('guess → submitMove, HUD обновляется серверными score/streak/better', async () => {
    startSession.mockResolvedValue({ session: session() } as StartGuessSessionResponse);
    submitMove.mockResolvedValue({
      move: moveDto(),
      score: 7,
      currentStreak: 1,
      betterThanPlayerCount: 2,
    } as SubmitGuessMoveResponse);
    renderWithProviders(
      <GuessSessionRunner pgn={PGN} side="white" gameSource="pgn" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-session').getAttribute('data-status')).toBe('playing'),
    );
    (screen.getByTestId('fire-guess') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('guess-hud-score').textContent).toContain('7'),
    );
    expect(screen.getByTestId('guess-hud-streak').textContent).toContain('1');
    expect(screen.getByTestId('guess-hud-better').textContent).toContain('2');
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
});
