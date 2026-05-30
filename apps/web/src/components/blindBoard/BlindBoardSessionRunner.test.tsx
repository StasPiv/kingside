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

// KS-3443 (F2): FinalScreen зависит от AuthContext + api.getLeaderboard;
// в этом наборе тестов wiring'а проверяем только, что SessionRunner
// переключился в final-фазу и пробросил session/lastAnswer. Сам экран
// покрывается BlindBoardFinalScreen.test.tsx.
vi.mock('./BlindBoardFinalScreen', () => ({
  BlindBoardFinalScreen: ({
    session,
    lastAnswer,
  }: {
    session: { finishReason: string | null; bestStreak: number };
    lastAnswer: {
      expectedSquare?: string;
      expectedPieceType?: string;
    } | null;
  }) => (
    <div
      data-testid="blind-board-final"
      data-finish-reason={session.finishReason ?? ''}
      data-best={String(session.bestStreak)}
      data-expected={
        lastAnswer?.expectedPieceType && lastAnswer?.expectedSquare
          ? `${lastAnswer.expectedPieceType}${lastAnswer.expectedSquare}`
          : ''
      }
    />
  ),
  // KS-3448: SessionRunner импортирует helper piecesToFen из этого
  // модуля — мок должен его экспортировать, иначе runtime-undefined в
  // фазе memorize. Минимальная стаб-реализация: маркер «есть R7»,
  // достаточный для проверки в тесте.
  piecesToFen: (pieces: Array<{ square: string; type: string }>) => {
    if (pieces.length === 0) return '8/8/8/8/8/8/8/8 w - - 0 1';
    const r = pieces.find((p) => p.square === 'a1' && p.type === 'R');
    return r ? '8/8/8/8/8/8/8/R7 w - - 0 1' : '8/8/8/8/8/8/8/8 w - - 0 1';
  },
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
  it('старт → playing с HUD; runner получает session.nextMove (без startPosition → пропускаем memorize)', async () => {
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

  it('KS-3448: старт со startPosition → memorizing → клик «Готов» → playing', async () => {
    startSession.mockResolvedValue({
      session: session(),
      startPosition: [
        { square: 'a1', type: 'R' },
        { square: 'e4', type: 'N' },
        { square: 'd5', type: 'B' },
        { square: 'g7', type: 'B' },
        { square: 'h8', type: 'Q' },
      ],
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    // Сначала memorize.
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('memorizing'),
    );
    // HUD скрыт.
    expect(screen.queryByTestId('blind-board-hud')).toBeNull();
    // Доска с FEN из startPosition (R на a1 → '…/R7').
    expect(
      screen
        .getByTestId('blind-board-memorize-board')
        .getAttribute('data-fen'),
    ).toContain('R7');
    // Клик «Готов» → playing.
    (
      screen.getByTestId('blind-board-memorize-ready') as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    // HUD появился; runner получил session.nextMove.
    expect(screen.getByTestId('blind-board-hud-round')).toBeTruthy();
    expect(screen.getByTestId('runner-stub').getAttribute('data-move')).toBe(
      'e2-e4',
    );
  });

  it('KS-3448: пустой startPosition → сразу playing (fallback)', async () => {
    startSession.mockResolvedValue({
      session: session(),
      startPosition: [],
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    expect(screen.queryByTestId('blind-board-memorize')).toBeNull();
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
    // Stub-моки FinalScreen прокидывают session/lastAnswer в data-*.
    expect(
      screen.getByTestId('blind-board-final').getAttribute('data-expected'),
    ).toBe('Ne4');
    expect(
      screen.getByTestId('blind-board-final').getAttribute('data-best'),
    ).toBe('1');
  });

  // KS-3453: dead-end удалён из BlindBoardFinishReason — сервер
  // всегда находит ход в одной из 5 фигур. Тест на dead-end сценарий
  // снят. Единственный финиш по факту — wrong-answer (покрыт выше).
});
