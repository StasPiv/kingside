import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import type { PuzzleDto, PuzzleStepPayload } from '@kingside/shared';
import { PuzzleStep, resolvePuzzles } from './PuzzleStep';

const mockPuzzleApi = {
  submitAttempt: vi.fn(),
};

vi.mock('../../../api-puzzle', async () => {
  const actual = await vi.importActual<typeof import('../../../api-puzzle')>(
    '../../../api-puzzle',
  );
  return {
    ...actual,
    puzzleApi: {
      submitAttempt: (...args: unknown[]) => mockPuzzleApi.submitAttempt(...args),
    },
  };
});

const mockLessonsApi = {
  resolvePuzzleStep: vi.fn(),
};

vi.mock('../../../api/lessonsApi', async () => {
  const actual = await vi.importActual<typeof import('../../../api/lessonsApi')>(
    '../../../api/lessonsApi',
  );
  return {
    ...actual,
    lessonsApi: {
      resolvePuzzleStep: (...args: unknown[]) =>
        mockLessonsApi.resolvePuzzleStep(...args),
    },
  };
});

vi.mock('../../../hooks/useSounds', () => ({
  useSounds: () => ({ playSound: vi.fn() }),
  soundEventFromSan: () => 'move',
}));

const mockUseAuth = vi.fn();
vi.mock('../../../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

// PuzzleBoard мокается лёгкой заглушкой, через которую тест эмулирует
// ход игрока (по data-testid="board-move-{from}{to}").
vi.mock('../../PuzzleBoard', () => ({
  PuzzleBoard: ({
    enabled,
    onPieceDrop,
    children,
  }: {
    enabled: boolean;
    onPieceDrop: (a: { sourceSquare: string; targetSquare: string | null }) => boolean;
    children?: ReactNode;
  }) => (
    <div data-testid="puzzle-board-mock" data-enabled={String(enabled)}>
      <button
        type="button"
        data-testid="board-move-correct"
        onClick={() => onPieceDrop({ sourceSquare: 'e2', targetSquare: 'e4' })}
      />
      <button
        type="button"
        data-testid="board-move-wrong"
        onClick={() => onPieceDrop({ sourceSquare: 'e2', targetSquare: 'e3' })}
      />
      {children}
    </div>
  ),
}));

beforeEach(() => {
  mockPuzzleApi.submitAttempt.mockReset();
  mockLessonsApi.resolvePuzzleStep.mockReset();
  mockUseAuth.mockReturnValue({ user: { id: 'u1', username: 'Test' }, loading: false });
});

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makePuzzle(overrides: Partial<PuzzleDto> = {}): PuzzleDto {
  return {
    id: 'puz-1',
    fen: STARTING_FEN,
    moves: 'e2e4',
    rating: 1500,
    themes: 'opening',
    plays: 0,
    ...overrides,
  } as PuzzleDto;
}

describe('resolvePuzzles', () => {
  it('mode="ids" дёргает батч-эндпоинт с полным payload', async () => {
    const list = [makePuzzle({ id: 'a' }), makePuzzle({ id: 'b' }), makePuzzle({ id: 'c' })];
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce(list);

    const payload: PuzzleStepPayload = {
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: ['a', 'b', 'c'] },
    };
    const out = await resolvePuzzles(payload);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(mockLessonsApi.resolvePuzzleStep).toHaveBeenCalledTimes(1);
    expect(mockLessonsApi.resolvePuzzleStep).toHaveBeenCalledWith(payload);
  });

  it('mode="ids" с пустым массивом → пустой результат, без сетевого вызова', async () => {
    const out = await resolvePuzzles({
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: [] },
    });
    expect(out).toEqual([]);
    expect(mockLessonsApi.resolvePuzzleStep).not.toHaveBeenCalled();
  });

  it('mode="filter" пробрасывает payload в батч-эндпоинт и возвращает его ответ', async () => {
    const list = [makePuzzle({ id: 'x' }), makePuzzle({ id: 'y' }), makePuzzle({ id: 'z' })];
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce(list);

    const payload: PuzzleStepPayload = {
      type: 'puzzle',
      selection: {
        mode: 'filter',
        themes: ['fork'],
        ratingMin: 1500,
        ratingMax: 1700,
        limit: 3,
      },
    };
    const out = await resolvePuzzles(payload);
    expect(out.map((p) => p.id)).toEqual(['x', 'y', 'z']);
    expect(mockLessonsApi.resolvePuzzleStep).toHaveBeenCalledWith(payload);
  });
});

describe('<PuzzleStep>', () => {
  it('показывает loading, потом доску', async () => {
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([makePuzzle({ id: 'p1' })]);

    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: ['p1'] },
        }}
      />,
    );
    expect(screen.getByTestId('lesson-puzzle-step-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('puzzle-board-mock')).toHaveAttribute('data-enabled', 'true');
  });

  it('сценарий «решил»: правильный ход → submitAttempt(solved), счётчик solved=1, кнопка «Continue» активна, onStepDone вызван', async () => {
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([
      makePuzzle({ id: 'p1', moves: 'e2e4' }),
    ]);
    mockPuzzleApi.submitAttempt.mockResolvedValue({});
    const onStepDone = vi.fn();

    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: ['p1'] },
        }}
        onStepDone={onStepDone}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('board-move-correct'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-correct')).toBeInTheDocument(),
    );

    expect(mockPuzzleApi.submitAttempt).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ result: 'solved', userMoves: 'e2e4' }),
    );

    expect(screen.queryByTestId('lesson-puzzle-step-next-puzzle')).toBeNull();
    const cont = screen.getByTestId('lesson-puzzle-step-complete');
    expect(cont).not.toBeDisabled();
    expect(onStepDone).toHaveBeenCalledTimes(1);

    fireEvent.click(cont);
    expect(onStepDone).toHaveBeenCalledTimes(2);
  });

  it('сценарий «не решил»: неправильный ход → submitAttempt(failed), статус incorrect, onStepDone НЕ вызван, кнопка дизейблед', async () => {
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([
      makePuzzle({ id: 'p1', moves: 'e2e4' }),
    ]);
    mockPuzzleApi.submitAttempt.mockResolvedValue({});
    const onStepDone = vi.fn();

    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: ['p1'] },
        }}
        onStepDone={onStepDone}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('board-move-wrong'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-incorrect')).toBeInTheDocument(),
    );

    expect(mockPuzzleApi.submitAttempt).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ result: 'failed' }),
    );
    expect(onStepDone).not.toHaveBeenCalled();

    const cont = screen.getByTestId('lesson-puzzle-step-complete');
    expect(cont).toBeDisabled();
    expect(cont).toHaveTextContent('Need more correct');
  });

  it('пустой набор (ids=[]) → error-state, без сетевого вызова', async () => {
    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: [] },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-error')).toBeInTheDocument(),
    );
    expect(mockLessonsApi.resolvePuzzleStep).not.toHaveBeenCalled();
  });

  it('бэк вернул [] → error-state', async () => {
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([]);
    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: {
            mode: 'filter',
            themes: ['fork'],
            limit: 5,
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-error')).toBeInTheDocument(),
    );
  });

  it('гость (user=null) — попытка не отправляется', async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([
      makePuzzle({ id: 'p1', moves: 'e2e4' }),
    ]);

    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: ['p1'] },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('board-move-correct'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-correct')).toBeInTheDocument(),
    );
    expect(mockPuzzleApi.submitAttempt).not.toHaveBeenCalled();
  });

  it('minSolved меньше total: 1 решённая из 2 → onStepDone уже вызван после первой', async () => {
    mockLessonsApi.resolvePuzzleStep.mockResolvedValueOnce([
      makePuzzle({ id: 'p1', moves: 'e2e4' }),
      makePuzzle({ id: 'p2', moves: 'e2e4' }),
    ]);
    mockPuzzleApi.submitAttempt.mockResolvedValue({});
    const onStepDone = vi.fn();

    renderWithProviders(
      <PuzzleStep
        payload={{
          type: 'puzzle',
          selection: { mode: 'ids', puzzleIds: ['p1', 'p2'] },
          minSolved: 1,
        }}
        onStepDone={onStepDone}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('board-move-correct'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step-correct')).toBeInTheDocument(),
    );
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });
});
