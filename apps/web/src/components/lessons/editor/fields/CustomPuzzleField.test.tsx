import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { CustomPuzzle } from '@kingside/shared';

import { renderWithAuth } from '../../../../test/test-utils-auth';
import { CustomPuzzleField, MAX_SOLUTION_MOVES } from './CustomPuzzleField';

/**
 * KS-1909: тесты карточки custom puzzle.
 *
 * UCI-input используется как primary handle для теста — drag-drop
 * на `react-chessboard` через JSDOM воспроизводить нечем, а
 * валидация ходов идентична (общий `tryAppendMove`). Drag-drop
 * проверяется через handler-prop в smoke-тесте отдельно.
 */

vi.mock('react-chessboard', () => ({
  Chessboard: (props: {
    options?: {
      position?: string;
      boardOrientation?: string;
      onPieceDrop?: (args: {
        sourceSquare: string;
        targetSquare: string | null;
      }) => boolean;
    };
  }) => (
    <div
      data-testid="chessboard"
      data-fen={props.options?.position}
      data-orientation={props.options?.boardOrientation}
      data-drop={props.options?.onPieceDrop ? 'has-drop' : 'no-drop'}
    />
  ),
  // KS-4179: SetPositionModal (открываемый из CustomPuzzleField через
  // «Edit on board») зовёт `defaultPieces` для рендера встроенных
  // фигур (KS-3395 / KS-4155, дефолт pieceSet=`standard`). Без
  // экспорта mock падает «No defaultPieces export». Пустой Record
  // достаточен — реальные SVG в тестах не валидируем.
  defaultPieces: {} as Record<string, () => null>,
}));

const SCHOLAR_FEN = 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function mkPuzzle(over: Partial<CustomPuzzle> = {}): CustomPuzzle {
  return {
    fen: START_FEN,
    solutionMoves: [],
    ...over,
  };
}

function renderField(over: Partial<CustomPuzzle> = {}, idx = 0) {
  const onChange = vi.fn();
  const onDelete = vi.fn();
  const utils = renderWithAuth(
    <CustomPuzzleField
      index={idx}
      puzzle={mkPuzzle(over)}
      onChange={onChange}
      onDelete={onDelete}
    />,
  );
  return { ...utils, onChange, onDelete };
}

function getModalScope() {
  const modal = document.querySelector('.set-position-modal');
  if (!modal) throw new Error('SetPositionModal is not rendered');
  return within(modal as HTMLElement);
}

function typeAndSubmit(idx: number, uci: string) {
  const input = screen.getByTestId(
    `editor-custom-puzzle-${idx}-uci-input`,
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: uci } });
  fireEvent.click(
    screen.getByTestId(`editor-custom-puzzle-${idx}-uci-submit`),
  );
}

describe('<CustomPuzzleField>', () => {
  it('рендерит карточку с дефолтным FEN и заголовком по index+1', () => {
    renderField({}, 0);
    expect(screen.getByTestId('editor-custom-puzzle-0')).toBeInTheDocument();
    expect(screen.getByTestId('editor-custom-puzzle-0-fen')).toHaveValue(
      START_FEN,
    );
    // h5 содержит "1" (index + 1)
    expect(screen.getByText(/Custom puzzle #1/)).toBeInTheDocument();
  });

  it('warning «No solution recorded yet» при пустом solutionMoves', () => {
    renderField({}, 0);
    expect(
      screen.getByTestId('editor-custom-puzzle-0-no-solution'),
    ).toBeInTheDocument();
  });

  it('по умолчанию режим setPosition (если solutionMoves пусто) — UCI-input не виден', () => {
    renderField({}, 0);
    expect(
      screen.queryByTestId('editor-custom-puzzle-0-uci-input'),
    ).not.toBeInTheDocument();
  });

  it('при наличии solutionMoves стартует в режиме recordSolution — UCI-input виден', () => {
    renderField({ solutionMoves: ['e2e4'] }, 0);
    expect(
      screen.getByTestId('editor-custom-puzzle-0-uci-input'),
    ).toBeInTheDocument();
  });

  it('переключение Set Position / Record Solution', () => {
    renderField({}, 0);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-mode-record'));
    expect(
      screen.getByTestId('editor-custom-puzzle-0-uci-input'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-mode-set'));
    expect(
      screen.queryByTestId('editor-custom-puzzle-0-uci-input'),
    ).not.toBeInTheDocument();
  });

  it('Edit on board открывает SetPositionModal с FEN из puzzle, Apply пишет fen и сбрасывает solution', () => {
    const { onChange } = renderField({ solutionMoves: ['e2e4'] }, 0);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-edit-board'));
    // модалка отрисована (используем her own scope)
    const modal = getModalScope();
    const fenInput = modal.getByDisplayValue(START_FEN);
    fireEvent.change(fenInput, { target: { value: SCHOLAR_FEN } });
    fireEvent.click(modal.getByRole('button', { name: /Apply/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as CustomPuzzle;
    expect(next.fen).toBe(SCHOLAR_FEN);
    // смена позиции инвалидирует solution
    expect(next.solutionMoves).toEqual([]);
  });

  it('запись валидного хода через UCI-input → onChange с обновлённым solutionMoves', () => {
    const { onChange } = renderField({}, 0);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-mode-record'));
    typeAndSubmit(0, 'e2e4');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      (onChange.mock.calls[0][0] as CustomPuzzle).solutionMoves,
    ).toEqual(['e2e4']);
  });

  it('illegal UCI → ошибка-баннер, onChange НЕ вызывается', () => {
    const { onChange } = renderField({}, 0);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-mode-record'));
    typeAndSubmit(0, 'e2e9');
    expect(
      screen.getByTestId('editor-custom-puzzle-0-move-error'),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('illegal move (e2e5 не легальный) → ошибка', () => {
    const { onChange } = renderField({}, 0);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-mode-record'));
    typeAndSubmit(0, 'e2e5');
    expect(
      screen.getByTestId('editor-custom-puzzle-0-move-error'),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('подпись «Your turn» / «Opponent» меняется по чётности solutionMoves.length', () => {
    const { rerender } = renderField({ solutionMoves: [] }, 0);
    // 0 ходов → следующий ход student'а (index=0 чётный)
    expect(
      screen.getByTestId('editor-custom-puzzle-0-moves').textContent,
    ).toMatch(/Your turn/);
    rerender(
      <CustomPuzzleField
        index={0}
        puzzle={mkPuzzle({ solutionMoves: ['e2e4'] })}
        onChange={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('editor-custom-puzzle-0-moves').textContent,
    ).toMatch(/Opponent/);
  });

  it('Undo last снимает последний ход', () => {
    const { onChange } = renderField(
      { solutionMoves: ['e2e4', 'e7e5'] },
      0,
    );
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-undo'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      (onChange.mock.calls[0][0] as CustomPuzzle).solutionMoves,
    ).toEqual(['e2e4']);
  });

  it('Reset solution очищает solutionMoves, FEN не трогает', () => {
    const { onChange } = renderField(
      { solutionMoves: ['e2e4', 'e7e5'] },
      0,
    );
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-reset'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as CustomPuzzle;
    expect(next.solutionMoves).toEqual([]);
    expect(next.fen).toBe(START_FEN);
  });

  it('Delete this puzzle вызывает onDelete', () => {
    const { onDelete } = renderField({}, 2);
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-2-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('лимит 40 ходов: при достижении ввод отключён + warning', () => {
    // Подкладываем 40 валидных ходов от стартовой позиции — для теста
    // делаем массив-плейсхолдер. Поскольку tryAppendMove проверяет
    // легальность всей цепочки, начнём с тех ходов, которые точно
    // легальны: e2e4 + a7a6 + чередуем тихие ходы. Проще проверить
    // ровно граничный случай через payload.solutionMoves.length===40.
    const moves = Array.from({ length: MAX_SOLUTION_MOVES }, (_, i) =>
      // не валидируем — карточка сначала рендерит, valid не для cap
      i % 2 === 0 ? 'e2e4' : 'e7e5',
    );
    renderField({ solutionMoves: moves }, 0);
    expect(
      screen.getByTestId('editor-custom-puzzle-0-too-long'),
    ).toBeInTheDocument();
    const input = screen.getByTestId(
      'editor-custom-puzzle-0-uci-input',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('orientation/caption/themes пишут в payload', () => {
    const { onChange } = renderField({}, 0);
    fireEvent.change(
      screen.getByTestId('editor-custom-puzzle-0-orientation'),
      { target: { value: 'black' } },
    );
    expect(
      (onChange.mock.calls[0][0] as CustomPuzzle).orientation,
    ).toBe('black');

    onChange.mockClear();
    fireEvent.change(screen.getByTestId('editor-custom-puzzle-0-caption'), {
      target: { value: 'Mate in 1' },
    });
    expect(
      (onChange.mock.calls[0][0] as CustomPuzzle).caption,
    ).toBe('Mate in 1');

    onChange.mockClear();
    fireEvent.change(screen.getByTestId('editor-custom-puzzle-0-themes'), {
      target: { value: 'mateIn1, kingside' },
    });
    expect(
      (onChange.mock.calls[0][0] as CustomPuzzle).themes,
    ).toEqual(['mateIn1', 'kingside']);
  });
});
