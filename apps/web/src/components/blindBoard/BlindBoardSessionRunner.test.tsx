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
    // KS-3484 (V2 §15): level обязателен в DTO.
    level: 1,
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

  it('startSession упал → error (generic, unknown kind)', async () => {
    startSession.mockRejectedValue(new Error('500'));
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('error'),
    );
    expect(
      screen.getByTestId('blind-board-session').getAttribute('data-error-kind'),
    ).toBe('unknown');
  });

  it('KS-3464: REQUEST_TIMEOUT → kind=timeout + text «Сервер не отвечает»', async () => {
    const { ApiError } = await import('../../ApiError');
    startSession.mockRejectedValue(
      new ApiError('Request timed out', 'REQUEST_TIMEOUT', 0),
    );
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('error'),
    );
    expect(
      screen.getByTestId('blind-board-session').getAttribute('data-error-kind'),
    ).toBe('timeout');
    expect(
      screen.getByTestId('blind-board-session-error').textContent,
    ).toContain('server is not responding');
  });

  it('KS-3464: NETWORK_ERROR → kind=network + тот же network-text', async () => {
    const { ApiError } = await import('../../ApiError');
    startSession.mockRejectedValue(
      new ApiError('Failed to fetch', 'NETWORK_ERROR', 0),
    );
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-error-kind'),
      ).toBe('network'),
    );
  });

  it('KS-3464: SESSION_EXPIRED (401) → kind=session-expired + auth-text', async () => {
    const { ApiError } = await import('../../ApiError');
    startSession.mockRejectedValue(
      new ApiError('Session expired', 'SESSION_EXPIRED', 401),
    );
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-error-kind'),
      ).toBe('session-expired'),
    );
    expect(
      screen.getByTestId('blind-board-session-error').textContent,
    ).toContain('Session expired');
  });

  it('KS-3464: 500 ApiError → kind=server + server-text', async () => {
    const { ApiError } = await import('../../ApiError');
    startSession.mockRejectedValue(
      new ApiError('Internal', 'INTERNAL', 500),
    );
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-error-kind'),
      ).toBe('server'),
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

  // KS-3489 (V2 §15 F2) — HUD pill уровня + level-up overlay.
  it('KS-3489: HUD показывает L{level} + хинт о следующей фигуре из addOrder', async () => {
    startSession.mockResolvedValue({
      session: session({ level: 1, streak: 4 }),
      startPosition: [],
      config: {
        startPieces: ['Q', 'N', 'R'],
        addOrder: ['B', 'B'],
        memorizeTimeSec: 5,
      },
      level: 1,
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    expect(screen.getByTestId('blind-board-hud-level').textContent).toContain(
      'L1',
    );
    const hint = screen.getByTestId('blind-board-hud-level-hint');
    expect(hint.getAttribute('data-next-piece')).toBe('B');
    // streak=4 → до level-up осталось 6 (10-4).
    expect(hint.getAttribute('data-steps')).toBe('6');
  });

  it('KS-3557 (V3 §16): progressionEnabled=false → HUD-hint скрыт', async () => {
    startSession.mockResolvedValue({
      session: session({ level: 1, streak: 4 }),
      startPosition: [],
      config: {
        startPieces: ['Q', 'N', 'R'],
        addOrder: ['B', 'B'],
        memorizeTimeSec: 5,
        progressionEnabled: false,
        levelDurationRounds: 10,
      },
      level: 1,
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    expect(screen.getByTestId('blind-board-hud-level').textContent).toContain(
      'L1',
    );
    // Подсказка про следующую фигуру/раунды отсутствует.
    expect(
      screen.queryByTestId('blind-board-hud-level-hint'),
    ).toBeNull();
  });

  it('KS-3557: levelDurationRounds=5 (V3) → stepsToLvl считается от 5', async () => {
    startSession.mockResolvedValue({
      session: session({ level: 1, streak: 2 }),
      startPosition: [],
      config: {
        startPieces: ['Q', 'N', 'R'],
        addOrder: ['B'],
        memorizeTimeSec: 5,
        progressionEnabled: true,
        levelDurationRounds: 5,
      },
      level: 1,
    } as StartBlindBoardSessionResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    const hint = screen.getByTestId('blind-board-hud-level-hint');
    // streak=2, duration=5 → stepsToLvl = 5 - (2%5) = 3.
    expect(hint.getAttribute('data-steps')).toBe('3');
  });

  it('KS-3489: response.levelUp → overlay рендерится со всеми фигурами', async () => {
    startSession.mockResolvedValue({
      session: session(),
      startPosition: [
        { square: 'a1', type: 'R' },
        { square: 'e4', type: 'N' },
      ],
      config: {
        startPieces: ['R', 'N'],
        addOrder: ['B'],
        memorizeTimeSec: 5,
      },
      level: 1,
    } as StartBlindBoardSessionResponse);
    submitAnswer.mockResolvedValue({
      correct: true,
      session: session({ level: 2, round: 11, streak: 10, bestStreak: 10 }),
      // KS-3522: backend теперь отдаёт boardPosition (KS-3520) —
      // snapshot всех фигур; фронт берёт его из event'а и рисует.
      levelUp: {
        newLevel: 2,
        newPiece: 'B',
        newSquare: 'd5',
        boardPosition: [
          { square: 'a1', type: 'R' },
          { square: 'h8', type: 'N' },
          { square: 'd5', type: 'B' },
        ],
      },
    } as SubmitBlindBoardAnswerResponse);
    renderWithProviders(<BlindBoardSessionRunner api={api} />);
    // Сначала memorizing → Ready → playing.
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('memorizing'),
    );
    (
      screen.getByTestId('blind-board-memorize-ready') as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-session').getAttribute('data-status'),
      ).toBe('playing'),
    );
    (screen.getByTestId('fire-submit-Q-d4') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('blind-board-level-up')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('blind-board-level-up').getAttribute('data-new-level'),
    ).toBe('2');
    // HUD теперь L2.
    await waitFor(() =>
      expect(screen.getByTestId('blind-board-hud-level').textContent).toContain(
        'L2',
      ),
    );
    // Ready закрывает overlay.
    (
      screen.getByTestId('blind-board-level-up-ready') as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(screen.queryByTestId('blind-board-level-up')).toBeNull(),
    );
  });
});
