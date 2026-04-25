import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { StepPayload } from '@kingside/shared';

import { renderWithProviders } from '../../../../test/test-utils';
import { PuzzleFields } from './PuzzleFields';

/**
 * KS-1909: расширение `PuzzleFields` третьим режимом `'custom'`.
 *
 * Здесь покрываем именно склейку (выбор режима, добавление /
 * удаление карточек, лимит 20). Карточка `<CustomPuzzleField>`
 * протестирована отдельно.
 */

vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard" />,
}));

function mkPayload(
  selection: Extract<StepPayload, { type: 'puzzle' }>['selection'] = {
    mode: 'filter',
    themes: ['middlegame'],
    limit: 3,
  },
): Extract<StepPayload, { type: 'puzzle' }> {
  return { type: 'puzzle', selection };
}

describe('<PuzzleFields> custom mode (KS-1909)', () => {
  it('select содержит три опции: ids / filter / custom', () => {
    renderWithProviders(
      <PuzzleFields payload={mkPayload()} onChange={vi.fn()} />,
    );
    const sel = screen.getByTestId('editor-step-puzzle-mode') as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toEqual(['ids', 'filter', 'custom']);
  });

  it('переключение filter → custom создаёт пустой customPuzzles', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PuzzleFields payload={mkPayload()} onChange={onChange} />,
    );
    fireEvent.change(screen.getByTestId('editor-step-puzzle-mode'), {
      target: { value: 'custom' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Extract<
      StepPayload,
      { type: 'puzzle' }
    >;
    expect(next.selection.mode).toBe('custom');
    if (next.selection.mode === 'custom') {
      expect(next.selection.customPuzzles).toEqual([]);
    }
  });

  it('mode=custom + 0 puzzle: list-блок виден, кнопка «+ Add custom puzzle» активна', () => {
    renderWithProviders(
      <PuzzleFields
        payload={mkPayload({ mode: 'custom', customPuzzles: [] })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-step-puzzle-custom-list')).toBeInTheDocument();
    const addBtn = screen.getByTestId(
      'editor-step-puzzle-custom-add',
    ) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    expect(
      screen.queryByTestId('editor-step-puzzle-custom-limit'),
    ).not.toBeInTheDocument();
  });

  it('клик «+ Add custom puzzle» добавляет дефолтный CustomPuzzle в payload', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PuzzleFields
        payload={mkPayload({ mode: 'custom', customPuzzles: [] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-step-puzzle-custom-add'));
    const next = onChange.mock.calls[0][0] as Extract<
      StepPayload,
      { type: 'puzzle' }
    >;
    if (next.selection.mode !== 'custom') throw new Error('mode mismatch');
    expect(next.selection.customPuzzles).toHaveLength(1);
    expect(next.selection.customPuzzles[0].fen).toMatch(/^rnbqkbnr/);
    expect(next.selection.customPuzzles[0].solutionMoves).toEqual([]);
  });

  it('20 puzzle-карточек → кнопка disabled + показывается limit-сообщение', () => {
    const customPuzzles = Array.from({ length: 20 }, () => ({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      solutionMoves: [],
    }));
    renderWithProviders(
      <PuzzleFields
        payload={mkPayload({ mode: 'custom', customPuzzles })}
        onChange={vi.fn()}
      />,
    );
    const addBtn = screen.getByTestId(
      'editor-step-puzzle-custom-add',
    ) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
    expect(
      screen.getByTestId('editor-step-puzzle-custom-limit'),
    ).toBeInTheDocument();
  });

  it('удаление карточки уменьшает customPuzzles', () => {
    const onChange = vi.fn();
    const customPuzzles = [
      {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        solutionMoves: [],
      },
      {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        solutionMoves: [],
      },
    ];
    renderWithProviders(
      <PuzzleFields
        payload={mkPayload({ mode: 'custom', customPuzzles })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-custom-puzzle-0-delete'));
    const next = onChange.mock.calls[0][0] as Extract<
      StepPayload,
      { type: 'puzzle' }
    >;
    if (next.selection.mode !== 'custom') throw new Error('mode mismatch');
    expect(next.selection.customPuzzles).toHaveLength(1);
  });

  it('mode=ids/filter → custom-list не рендерится (регрессия)', () => {
    renderWithProviders(
      <PuzzleFields
        payload={mkPayload({ mode: 'ids', puzzleIds: ['abc'] })}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId('editor-step-puzzle-custom-list'),
    ).not.toBeInTheDocument();
  });
});
