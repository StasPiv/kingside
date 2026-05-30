import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { BlindBoardSessionRunner } from './BlindBoardSessionRunner';
import type {
  BlindBoardSessionDto,
  StartBlindBoardSessionResponse,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

/**
 * KS-3442 (ADR-088 §11 F1) — wiring blindBoardApi + BlindBoardRunner
 * + финал-экран. Runner замокан: пробрасывает кнопки submit/cancel.
 */

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: () => <div data-testid="mock-board" />,
}));

vi.mock('./BlindBoardRunner', () => ({
  BlindBoardRunner: ({
    move,
    onSubmit,
    disabled,
  }: {
    move: { from: string; to: string } | null;
    onSubmit: (a: { square: string; pieceType: 'Q' | 'R' | 'B' | 'N' }) => void;
    disabled?: boolean;
  }) => (
    <div
      data-testid="runner-stub"
      data-move={move ? `${move.from}-${move.to}` : ''}
      data-disabled={String(!!disabled)}
    >
      <button
        type="button"
        data-testid="fire-submit-Q-d4"
        onClick={() => onSubmit({ square: 'd4', pieceType: 'Q' })}
      >
        Q@d4
      </button>
    </div>
  ),
}));

const startSession = vi.fn();
const submitAnswer = vi.fn();
const getLeaderboard = vi.fn();
const api = { startSession, submitAnswer, getLeaderboard };

function session(over: Partial<BlindBoardSessionDto> = {}): BlindBoardSessionDto {
  return {
    id: 's-1',
    status: 'active',
    finishReason: null,
    round: 1,
    streak: 0,
    bestStreak: 0,
    nextMove: { from: 'e2', to: 'e4' },
    startedAt: '2026-05-30T00:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

beforeEach(() => {
  startSession.mockReset();
  submitAnswer.mockReset();
  getLeaderboard.mockReset();
});

describe('<BlindBoardSessionRunner>', () => {
  it('старт → playing с HUD; runner получает session.nextMove', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    expect(screen.getByTestId('blind-board-hud-round').textContent).toContain(
      '1',
    );
    expect(screen.getByTestId('runner-stub').getAttribute('data-move')).toBe(
      'e2-e4',
    );
  });

  it('startSession упал → error', async () => {
    startSession.mockRejectedValue(new Error('500'));
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('error'),
    );
  });

  it('правильный ответ → submitAnswer, следующий ход (round+1, новый move)', async () => {
    startSession.mockResolvedValue({
      session: session({ round: 1, streak: 0, bestStreak: 0 }),
    } as StartBlindBoardSessionResponse);
    submitAnswer.mockResolvedValue({
      correct: true,
      session: session({
        round: 2,
        streak: 1,
        bestStreak: 1,
        nextMove: { from: 'g1', to: 'f3' },
      }),
    } as SubmitBlindBoardAnswerResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    (screen.getByTestId('fire-submit-Q-d4') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('runner-stub').getAttribute('data-move')).toBe(
        'g1-f3',
      ),
    );
    expect(screen.getByTestId('blind-board-hud-round').textContent).toContain(
      '2',
    );
    expect(submitAnswer).toHaveBeenCalledWith('s-1', {
      square: 'd4',
      pieceType: 'Q',
    });
  });

  it('неверный ответ → финал с раскрытием expected + revealedPosition', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartBlindBoardSessionResponse);
    submitAnswer.mockResolvedValue({
      correct: false,
      expectedSquare: 'e4',
      expectedPieceType: 'N',
      revealedPosition: [
        { square: 'a1', type: 'R' },
        { square: 'e4', type: 'N' },
      ],
      session: session({
        status: 'finished',
        finishReason: 'wrong-answer',
        nextMove: null,
        round: 2,
        streak: 0,
        bestStreak: 1,
      }),
    } as SubmitBlindBoardAnswerResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    (screen.getByTestId('fire-submit-Q-d4') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('blind-board-final')).toBeTruthy(),
    );
    expect(
      screen
        .getByTestId('blind-board-session')
        .getAttribute('data-finish-reason'),
    ).toBe('wrong-answer');
    expect(screen.getByTestId('blind-board-final-expected').textContent).toContain(
      'Ne4',
    );
    expect(screen.getByTestId('blind-board-final-best').textContent).toContain(
      '1',
    );
  });

  it('dead-end → финал с deadEnd-ремаркой', async () => {
    startSession.mockResolvedValue({
      session: session(),
    } as StartBlindBoardSessionResponse);
    submitAnswer.mockResolvedValue({
      correct: true,
      revealedPosition: [{ square: 'a1', type: 'R' }],
      session: session({
        status: 'finished',
        finishReason: 'dead-end',
        nextMove: null,
        round: 3,
        streak: 2,
        bestStreak: 2,
      }),
    } as SubmitBlindBoardAnswerResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    (screen.getByTestId('fire-submit-Q-d4') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(
        screen
          .getByTestId('blind-board-session')
          .getAttribute('data-finish-reason'),
      ).toBe('dead-end'),
    );
    expect(screen.getByTestId('blind-board-final-reason').textContent).toContain(
      'corner',
    );
  });
});
