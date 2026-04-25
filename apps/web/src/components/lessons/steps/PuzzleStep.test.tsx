import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import type { PuzzleDto, PuzzleStepPayload } from '@kingside/shared';
import { PuzzleStep, resolvePuzzles, customToInMemoryPuzzle } from './PuzzleStep';

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

  /**
   * KS-1910: custom puzzle — отдельная ветка по `mode='custom'`.
   * Никаких сетевых запросов, никакого submitAttempt, первый ход —
   * ход ученика (firstMoveIsUser=true).
   */
  describe('custom puzzle (KS-1910)', () => {
    const CUSTOM_FEN =
      'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';

    it('customToInMemoryPuzzle: маппит fen + solutionMoves + флаги', () => {
      const out = customToInMemoryPuzzle(
        {
          fen: CUSTOM_FEN,
          solutionMoves: ['e2e4', 'e7e5'],
          orientation: 'black',
          themes: ['mateIn1'],
          caption: 'Mate in 1',
        },
        2,
      );
      expect(out.id).toBe('custom:2');
      expect(out.fen).toBe(CUSTOM_FEN);
      expect(out.moves).toBe('e2e4 e7e5');
      expect(out.rating).toBeNull();
      expect(out.isCustom).toBe(true);
      expect(out.firstMoveIsUser).toBe(true);
      expect(out.customOrientation).toBe('black');
    });

    it('mode="custom" → resolvePuzzles синхронно из customPuzzles, без сетевого запроса', async () => {
      const list = await resolvePuzzles({
        type: 'puzzle',
        selection: {
          mode: 'custom',
          customPuzzles: [
            { fen: CUSTOM_FEN, solutionMoves: ['e2e4'] },
            { fen: CUSTOM_FEN, solutionMoves: ['d2d4', 'd7d5'] },
          ],
        },
      });
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('custom:0');
      expect(list[1].id).toBe('custom:1');
      expect(mockLessonsApi.resolvePuzzleStep).not.toHaveBeenCalled();
    });

    it('UI: при mode="custom" виден banner и НЕ дёргается resolvePuzzleStep', async () => {
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                { fen: STARTING_FEN, solutionMoves: ['e2e4'] },
              ],
            },
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
      );
      expect(
        screen.getByTestId('lesson-puzzle-step-custom-note'),
      ).toBeInTheDocument();
      expect(mockLessonsApi.resolvePuzzleStep).not.toHaveBeenCalled();
    });

    it('firstMoveIsUser: даже при solutionMoves длиной >1 первый ход НЕ проигрывается автоматом — доска enabled сразу', async () => {
      // Custom puzzle с двумя ходами: e2e4 (ученик), e7e5 (соперник).
      // Lichess preconstant с moves длиной >1 проиграл бы первый
      // ход (setup) с задержкой 300мс — для custom этого нет.
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                {
                  fen: STARTING_FEN,
                  solutionMoves: ['e2e4', 'e7e5'],
                },
              ],
            },
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
      );
      // Сразу enabled, без задержки на setup-move.
      expect(screen.getByTestId('puzzle-board-mock')).toHaveAttribute(
        'data-enabled',
        'true',
      );
    });

    it('правильный ход → onStepDone вызван, submitAttempt НЕ вызван', async () => {
      const onStepDone = vi.fn();
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                { fen: STARTING_FEN, solutionMoves: ['e2e4'] },
              ],
            },
          }}
          onStepDone={onStepDone}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId('board-move-correct'));
      await waitFor(() =>
        expect(
          screen.getByTestId('lesson-puzzle-step-correct'),
        ).toBeInTheDocument(),
      );
      expect(onStepDone).toHaveBeenCalled();
      // ADR-029 §5.2: submitAttempt skip для custom.
      expect(mockPuzzleApi.submitAttempt).not.toHaveBeenCalled();
    });

    it('неправильный ход → incorrect-state, submitAttempt всё равно НЕ вызван', async () => {
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                { fen: STARTING_FEN, solutionMoves: ['e2e4'] },
              ],
            },
          }}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId('board-move-wrong'));
      await waitFor(() =>
        expect(
          screen.getByTestId('lesson-puzzle-step-incorrect'),
        ).toBeInTheDocument(),
      );
      expect(mockPuzzleApi.submitAttempt).not.toHaveBeenCalled();
    });

    it('KS-1912: пустой customPuzzles → empty-state, не падает, banner НЕ виден', async () => {
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: { mode: 'custom', customPuzzles: [] },
          }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('lesson-puzzle-step-error'),
        ).toBeInTheDocument(),
      );
      // Текст empty-state — про авторскую задачу, не «нет задач из БД».
      expect(
        screen.getByTestId('lesson-puzzle-step-error').textContent,
      ).toMatch(/no puzzles yet|не наполнен|нет задач/i);
      expect(
        screen.queryByTestId('lesson-puzzle-step-custom-note'),
      ).not.toBeInTheDocument();
      expect(mockLessonsApi.resolvePuzzleStep).not.toHaveBeenCalled();
    });

    it('KS-1912: customPuzzles с пустым solutionMoves пропускается, оставляет валидные', async () => {
      const onStepDone = vi.fn();
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                { fen: STARTING_FEN, solutionMoves: [] }, // пропускается
                { fen: STARTING_FEN, solutionMoves: ['e2e4'] }, // остаётся
              ],
            },
          }}
          onStepDone={onStepDone}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
      );
      // Один отрендеренный puzzle (тот, что с непустым solutionMoves).
      expect(
        screen.getByTestId('lesson-puzzle-step-progress').textContent,
      ).toMatch(/1\/1|1 of 1/i);
    });

    it('KS-1912: все customPuzzles с пустым solutionMoves → empty-state', async () => {
      renderWithProviders(
        <PuzzleStep
          payload={{
            type: 'puzzle',
            selection: {
              mode: 'custom',
              customPuzzles: [
                { fen: STARTING_FEN, solutionMoves: [] },
                { fen: STARTING_FEN, solutionMoves: [] },
              ],
            },
          }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('lesson-puzzle-step-error'),
        ).toBeInTheDocument(),
      );
    });

    it('Регрессия: mode="ids" → banner НЕ виден', async () => {
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
      expect(
        screen.queryByTestId('lesson-puzzle-step-custom-note'),
      ).not.toBeInTheDocument();
    });
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
