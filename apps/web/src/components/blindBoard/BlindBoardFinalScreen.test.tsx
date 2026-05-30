import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { BlindBoardFinalScreen, piecesToFen } from './BlindBoardFinalScreen';
import type {
  BlindBoardLeaderboardResponse,
  BlindBoardSessionDto,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

/**
 * KS-3443 (ADR-088 §11 F2) — финал-экран blind-board: streak, личный
 * рекорд, лидерборд, бейдж dead-end, раскрытие revealedPosition.
 */

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: { position?: string };
  }) => (
    <div data-testid="mock-board" data-position={options.position ?? ''} />
  ),
}));

// AuthContext не смонтирован тестовой обвязкой — стабим
// useAuth, чтобы вернуть конкретного пользователя для проверки
// «моя строка в лидерборде» / «новый рекорд».
const mockUser = { id: 'u-me', email: 'me@x' };
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    token: 't',
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

const getLeaderboard = vi.fn();
const api = { getLeaderboard };

function session(over: Partial<BlindBoardSessionDto> = {}): BlindBoardSessionDto {
  return {
    id: 's-1',
    status: 'finished',
    finishReason: 'wrong-answer',
    round: 2,
    streak: 0,
    bestStreak: 1,
    nextMove: null,
    startedAt: '2026-05-30T00:00:00.000Z',
    finishedAt: '2026-05-30T00:01:00.000Z',
    ...over,
  };
}

const wrongAnswer: SubmitBlindBoardAnswerResponse = {
  correct: false,
  expectedSquare: 'e4',
  expectedPieceType: 'N',
  revealedPosition: [
    { square: 'a1', type: 'R' },
    { square: 'e4', type: 'N' },
  ],
  session: session(),
};

beforeEach(() => {
  getLeaderboard.mockReset();
});

describe('piecesToFen', () => {
  it('пустой массив → empty FEN', () => {
    expect(piecesToFen([])).toBe('8/8/8/8/8/8/8/8 w - - 0 1');
  });
  it('одна фигура R на a1', () => {
    expect(piecesToFen([{ square: 'a1', type: 'R' }])).toBe(
      '8/8/8/8/8/8/8/R7 w - - 0 1',
    );
  });
  it('две фигуры на a1 и e4', () => {
    expect(
      piecesToFen([
        { square: 'a1', type: 'R' },
        { square: 'e4', type: 'N' },
      ]),
    ).toBe('8/8/8/8/4N3/8/8/R7 w - - 0 1');
  });
});

describe('<BlindBoardFinalScreen>', () => {
  it('wrong-answer: показывает causeText, expected, streak, доску с revealedPosition', async () => {
    getLeaderboard.mockResolvedValue({
      entries: [],
    } as BlindBoardLeaderboardResponse);
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session({ streak: 5, bestStreak: 5 })}
        lastAnswer={wrongAnswer}
        api={api}
      />,
    );
    expect(screen.getByTestId('blind-board-final-reason').textContent).toContain(
      'Wrong',
    );
    expect(
      screen.getByTestId('blind-board-final-expected').textContent,
    ).toContain('Ne4');
    expect(
      screen.getByTestId('blind-board-final-streak').textContent,
    ).toBe('5');
    expect(
      screen.getByTestId('blind-board-final-board').firstChild,
    ).toBeTruthy();
    expect(
      screen
        .getByTestId('mock-board')
        .getAttribute('data-position'),
    ).toContain('R7');
    // Лидерборд: ожидаем что после загрузки пустой массив → empty-сообщение.
    await waitFor(() =>
      expect(
        screen.queryByTestId('blind-board-final-leaderboard-loading'),
      ).toBeNull(),
    );
    expect(
      screen.getByTestId('blind-board-final-leaderboard-empty'),
    ).toBeTruthy();
  });

  it('dead-end: бейдж «загнал в угол» виден', async () => {
    getLeaderboard.mockResolvedValue({
      entries: [],
    } as BlindBoardLeaderboardResponse);
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session({
          finishReason: 'dead-end',
          streak: 4,
          bestStreak: 4,
        })}
        lastAnswer={{
          correct: true,
          revealedPosition: [],
          session: session({ finishReason: 'dead-end' }),
        }}
        api={api}
      />,
    );
    expect(screen.getByTestId('blind-board-final-badge-dead-end')).toBeTruthy();
    expect(
      screen.getByTestId('blind-board-final').getAttribute('data-finish-reason'),
    ).toBe('dead-end');
  });

  it('лидерборд: подсвечивает мою строку и личный рекорд = max(session, my entry)', async () => {
    getLeaderboard.mockResolvedValue({
      entries: [
        {
          userId: 'u-other',
          username: 'GM',
          bestStreak: 12,
          achievedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          userId: 'u-me',
          username: 'Me',
          bestStreak: 7,
          achievedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    } as BlindBoardLeaderboardResponse);
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session({ streak: 5, bestStreak: 5 })}
        lastAnswer={wrongAnswer}
        api={api}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('blind-board-final-leaderboard-list')).toBeTruthy(),
    );
    // Моя строка отмечена data-mine="true".
    const row2 = screen.getByTestId('blind-board-final-leaderboard-row-2');
    expect(row2.getAttribute('data-mine')).toBe('true');
    expect(row2.textContent).toContain('Me');
    expect(row2.textContent).toContain('7');
    // Личный рекорд: max(сессия 5, мой entry 7) = 7. Без new-record.
    expect(
      screen.getByTestId('blind-board-final-personal-best').textContent,
    ).toBe('7');
    expect(
      screen.queryByTestId('blind-board-final-new-record'),
    ).toBeNull();
  });

  it('новый рекорд: сессия побила существующий best в лидерборде', async () => {
    getLeaderboard.mockResolvedValue({
      entries: [
        {
          userId: 'u-me',
          username: 'Me',
          bestStreak: 3,
          achievedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    } as BlindBoardLeaderboardResponse);
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session({ streak: 9, bestStreak: 9 })}
        lastAnswer={wrongAnswer}
        api={api}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-final-personal-best').textContent,
      ).toBe('9'),
    );
    expect(screen.getByTestId('blind-board-final-new-record')).toBeTruthy();
    expect(
      screen
        .getByTestId('blind-board-final-personal-best-box')
        .getAttribute('data-is-record'),
    ).toBe('true');
  });

  it('лидерборд: ошибка загрузки → error-сообщение', async () => {
    getLeaderboard.mockRejectedValue(new Error('500'));
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session({ streak: 2, bestStreak: 2 })}
        lastAnswer={wrongAnswer}
        api={api}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-final-leaderboard-error'),
      ).toBeTruthy(),
    );
  });

  it('onPlayAgain → click "Play again" вызывает callback', async () => {
    getLeaderboard.mockResolvedValue({
      entries: [],
    } as BlindBoardLeaderboardResponse);
    const onPlayAgain = vi.fn();
    renderWithProviders(
      <BlindBoardFinalScreen
        session={session()}
        lastAnswer={wrongAnswer}
        onPlayAgain={onPlayAgain}
        api={api}
      />,
    );
    (
      screen.getByTestId('blind-board-final-again') as HTMLButtonElement
    ).click();
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });
});
