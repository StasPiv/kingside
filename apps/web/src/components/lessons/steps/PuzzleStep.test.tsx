import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import type { PuzzleDto, PuzzleStepPayload } from '@kingside/shared';
import { PuzzleStep, resolvePuzzles } from './PuzzleStep';

const mockPuzzleApi = {
  getById: vi.fn(),
  getNext: vi.fn(),
  submitAttempt: vi.fn(),
};

vi.mock('../../../api-puzzle', async () => {
  const actual = await vi.importActual<typeof import('../../../api-puzzle')>(
    '../../../api-puzzle',
  );
  return {
    ...actual,
    puzzleApi: {
      getById: (...args: unknown[]) => mockPuzzleApi.getById(...args),
      getNext: (...args: unknown[]) => mockPuzzleApi.getNext(...args),
      submitAttempt: (...args: unknown[]) => mockPuzzleApi.submitAttempt(...args),
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
  mockPuzzleApi.getById.mockReset();
  mockPuzzleApi.getNext.mockReset();
  mockPuzzleApi.submitAttempt.mockReset();
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
  it('mode="ids" дёргает getById для каждого id', async () => {
    mockPuzzleApi.getById.mockImplementation((id: string) =>
      Promise.resolve(makePuzzle({ id })),
    );
    const out = await resolvePuzzles({ mode: 'ids', puzzleIds: ['a', 'b', 'c'] });
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(mockPuzzleApi.getById).toHaveBeenCalledTimes(3);
  });

  it('mode="ids" с пустым массивом → пустой результат, без сетевых вызовов', async () => {
    const out = await resolvePuzzles({ mode: 'ids', puzzleIds: [] });
    expect(out).toEqual([]);
    expect(mockPuzzleApi.getById).not.toHaveBeenCalled();
  });

  it('mode="filter" дедуплицирует по id и не превышает limit', async () => {
    let i = 0;
    const ids = ['x', 'x', 'y', 'y', 'z']; // эмуляция дублей с бэка
    mockPuzzleApi.getNext.mockImplementation(() =>
      Promise.resolve(makePuzzle({ id: ids[i++] ?? 'last' })),
    );
    const out = await resolvePuzzles({
      mode: 'filter',
      themes: ['fork'],
      ratingMin: 1500,
      ratingMax: 1700,
      limit: 3,
    });
    expect(out.map((p) => p.id)).toEqual(['x', 'y', 'z']);
    expect(mockPuzzleApi.getNext).toHaveBeenCalledWith({
      themes: ['fork'],
      ratingMin: 1500,
      ratingMax: 1700,
    });
  });
});

describe('<PuzzleStep>', () => {
  function renderWithIds(payload?: Partial<PuzzleStepPayload>) {
    const full: PuzzleStepPayload = {
      type: 'puzzle',
      selection: { mode: 'ids', puzzleIds: ['p1'] },
      ...payload,
    };
    return renderWithProviders(<PuzzleStep payload={full} />);
  }

  it('показывает loading, потом доску', async () => {
    mockPuzzleApi.getById.mockResolvedValueOnce(makePuzzle({ id: 'p1' }));
    renderWithIds();
    expect(screen.getByTestId('lesson-puzzle-step-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('lesson-puzzle-step')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('puzzle-board-mock')).toHaveAttribute('data-enabled', 'true');
  });

  it('сценарий «решил»: правильный ход → submitAttempt(solved), счётчик solved=1, кнопка «Continue» активна, onStepDone вызван', async () => {
    mockPuzzleApi.getById.mockResolvedValueOnce(makePuzzle({ id: 'p1', moves: 'e2e4' }));
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

    // Только одна задача в наборе → нет «Next puzzle», есть «Continue».
    expect(screen.queryByTestId('lesson-puzzle-step-next-puzzle')).toBeNull();
    const cont = screen.getByTestId('lesson-puzzle-step-complete');
    expect(cont).not.toBeDisabled();
    expect(onStepDone).toHaveBeenCalledTimes(1);

    // Повторный клик по «Continue» вызывает onStepDone снова — это явный
    // пользовательский ввод.
    fireEvent.click(cont);
    expect(onStepDone).toHaveBeenCalledTimes(2);
  });

  it('сценарий «не решил»: неправильный ход → submitAttempt(failed), статус incorrect, onStepDone НЕ вызван, кнопка дизейблед', async () => {
    mockPuzzleApi.getById.mockResolvedValueOnce(makePuzzle({ id: 'p1', moves: 'e2e4' }));
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

  it('пустой набор → error-state', async () => {
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
  });

  it('гость (user=null) — попытка не отправляется', async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    mockPuzzleApi.getById.mockResolvedValueOnce(makePuzzle({ id: 'p1', moves: 'e2e4' }));

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
    mockPuzzleApi.getById
      .mockResolvedValueOnce(makePuzzle({ id: 'p1', moves: 'e2e4' }))
      .mockResolvedValueOnce(makePuzzle({ id: 'p2', moves: 'e2e4' }));
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
