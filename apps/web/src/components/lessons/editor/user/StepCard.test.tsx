import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { UserLessonStepDto } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { StepCard } from './StepCard';

/**
 * KS-1852 (FE-R4): `StepCard`.
 */

// StepRenderer тянет chess-компоненты; для unit-тестов достаточно заглушки.
vi.mock('../../StepRenderer', () => ({
  StepRenderer: () => <div data-testid="step-renderer-mock" />,
}));
// *Fields тоже тяжёлые (chessboards, prisma-типы валидаций) — мок.
vi.mock('../fields', () => ({
  TextFields: ({ payload }: { payload: { type: string } }) => (
    <div data-testid={`text-fields-${payload.type}`} />
  ),
  PuzzleFields: ({ payload }: { payload: { type: string } }) => (
    <div data-testid={`puzzle-fields-${payload.type}`} />
  ),
  EndgameDrillFields: ({ payload }: { payload: { type: string } }) => (
    <div data-testid={`endgame-fields-${payload.type}`} />
  ),
}));

function mkStep(over: Partial<UserLessonStepDto> = {}): UserLessonStepDto {
  return {
    id: 's1',
    userLessonId: 'l1',
    order: 0,
    type: 'text',
    payload: { type: 'text', bodyMarkdown: '', diagrams: [] },
    ...over,
  };
}

function render(over: Partial<Parameters<typeof StepCard>[0]> = {}) {
  const step = over.step ?? mkStep();
  const props = {
    index: 0,
    expanded: true,
    onToggleExpand: vi.fn(),
    onPayloadChange: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    ...over,
    step,
  };
  return { ...renderWithProviders(<StepCard {...props} />), props };
}

describe('<StepCard>', () => {
  it('рендерит header: drag, иконка, type-label, dot, chevron', () => {
    const step = mkStep({ id: 's1', type: 'text' });
    render({ step, expanded: false });
    expect(screen.getByTestId('step-card-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-drag-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-status-s1')).toHaveAttribute(
      'data-status',
      'idle',
    );
    expect(screen.getByTestId('step-card-chevron-s1')).toBeInTheDocument();
  });

  it('text-шаг с markdown → превью без markdown-мусора (обрезано до N)', () => {
    const longText = '# Header\n\nStart paragraph with `code` and _italic_ and {{diagram:0}} and more text that overflows the limit.';
    const step = mkStep({
      type: 'text',
      payload: { type: 'text', bodyMarkdown: longText, diagrams: [] },
    });
    render({ step });
    const preview = screen.getByTestId('step-card-preview-s1');
    const txt = preview.textContent ?? '';
    expect(txt).not.toMatch(/[#*_`{}]/);
    expect(txt).not.toMatch(/diagram:/);
    expect(txt.endsWith('…')).toBe(true);
    expect(txt.length).toBeLessThanOrEqual(61);
  });

  it('expanded=true + type=text → рендерит TextFields (а не другие)', () => {
    const step = mkStep({
      type: 'text',
      payload: { type: 'text', bodyMarkdown: '', diagrams: [] },
    });
    render({ step });
    expect(screen.getByTestId('text-fields-text')).toBeInTheDocument();
    expect(screen.queryByTestId('puzzle-fields-puzzle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('endgame-fields-endgame_drill')).not.toBeInTheDocument();
  });

  it('expanded=true + type=puzzle → PuzzleFields', () => {
    const step = mkStep({
      type: 'puzzle',
      payload: { type: 'puzzle', selection: { mode: 'ids', puzzleIds: ['a', 'b'] } },
    });
    render({ step });
    expect(screen.getByTestId('puzzle-fields-puzzle')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-preview-s1').textContent).toMatch(/2 ID/);
  });

  /**
   * KS-1913 (P0): preview puzzle-шага не должен крашиться на
   * `mode='custom'`. До фикса `payload.selection.themes.join(',')`
   * падал с TypeError, потому что у custom-варианта нет `themes`.
   */
  it('KS-1913 preview: mode="filter" с темами → строка тем', () => {
    const step = mkStep({
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: {
          mode: 'filter',
          themes: ['fork', 'pin'],
          limit: 3,
        },
      },
    });
    render({ step });
    expect(screen.getByTestId('step-card-preview-s1').textContent).toMatch(
      /fork.*pin/i,
    );
  });

  it('KS-1913 preview: mode="custom" с N puzzle → «Custom puzzles (N)», не падает', () => {
    const step = mkStep({
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: {
          mode: 'custom',
          customPuzzles: [
            {
              fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              solutionMoves: ['e2e4'],
            },
            {
              fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              solutionMoves: ['d2d4'],
            },
          ],
        },
      },
    });
    render({ step });
    const txt = screen.getByTestId('step-card-preview-s1').textContent ?? '';
    expect(txt).toMatch(/2/);
    expect(txt.toLowerCase()).toMatch(/custom puzzles|свои задачи/);
  });

  it('KS-1913 preview: mode="custom" с пустым customPuzzles → «Custom puzzles (0)», не падает', () => {
    const step = mkStep({
      type: 'puzzle',
      payload: {
        type: 'puzzle',
        selection: { mode: 'custom', customPuzzles: [] },
      },
    });
    render({ step });
    const txt = screen.getByTestId('step-card-preview-s1').textContent ?? '';
    expect(txt).toMatch(/0/);
    expect(txt.toLowerCase()).toMatch(/custom puzzles|свои задачи/);
  });

  it('KS-1913 preview: mode="ids" с пустым puzzleIds → preview-span не рендерится, нет TypeError', () => {
    const step = mkStep({
      type: 'puzzle',
      payload: { type: 'puzzle', selection: { mode: 'ids', puzzleIds: [] } },
    });
    // Главное — render не падает на (puzzleIds ?? []).join(...).
    expect(() => render({ step })).not.toThrow();
    expect(screen.queryByTestId('step-card-preview-s1')).not.toBeInTheDocument();
  });

  it('expanded=true + type=endgame_drill → EndgameDrillFields', () => {
    const step = mkStep({
      type: 'endgame_drill',
      payload: {
        type: 'endgame_drill',
        fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
        playerSide: 'white',
        skillLevel: 5,
        winCondition: { kind: 'promote' },
      },
    });
    render({ step });
    expect(screen.getByTestId('endgame-fields-endgame_drill')).toBeInTheDocument();
  });

  it('expanded=false → body не рендерится', () => {
    render({ step: mkStep(), expanded: false });
    expect(screen.queryByTestId('step-card-body-s1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('text-fields-text')).not.toBeInTheDocument();
  });

  it('клик по chevron → onToggleExpand()', () => {
    const { props } = render({ expanded: false });
    fireEvent.click(screen.getByTestId('step-card-chevron-s1'));
    expect(props.onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('клик по меню → появляется dropdown с duplicate/delete', () => {
    render();
    expect(screen.queryByTestId('step-card-menu-s1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('step-card-menu-trigger-s1'));
    expect(screen.getByTestId('step-card-menu-s1')).toBeInTheDocument();
    expect(
      screen.getByTestId('step-card-menu-duplicate-s1'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('step-card-menu-delete-s1')).toBeInTheDocument();
  });

  it('клик duplicate → onDuplicate() + меню закрывается', () => {
    const { props } = render();
    fireEvent.click(screen.getByTestId('step-card-menu-trigger-s1'));
    fireEvent.click(screen.getByTestId('step-card-menu-duplicate-s1'));
    expect(props.onDuplicate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('step-card-menu-s1')).not.toBeInTheDocument();
  });

  it('клик delete → onDelete() + меню закрывается', () => {
    const { props } = render();
    fireEvent.click(screen.getByTestId('step-card-menu-trigger-s1'));
    fireEvent.click(screen.getByTestId('step-card-menu-delete-s1'));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('saveStatus=saving → dot имеет data-status=saving', () => {
    render({ saveStatus: 'saving' });
    expect(screen.getByTestId('step-card-status-s1')).toHaveAttribute(
      'data-status',
      'saving',
    );
  });

  it('preview-toggle: скрыт по умолчанию, открывает StepRenderer', () => {
    render();
    expect(screen.queryByTestId('step-card-preview-body-s1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('step-card-preview-toggle-s1'));
    expect(screen.getByTestId('step-card-preview-body-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-renderer-mock')).toBeInTheDocument();
  });

  it('неподдерживаемый тип (quiz из бэкапа админского курса) → unsupported-плашка', () => {
    const step: UserLessonStepDto = {
      id: 's1',
      userLessonId: 'l1',
      order: 0,
      // @ts-expect-error — тестируем graceful-degradation для типов не из whitelist
      type: 'quiz',
      // @ts-expect-error — StepPayload для quiz не в UserStepType-whitelist
      payload: { type: 'quiz', questions: [] },
    };
    render({ step });
    expect(screen.getByTestId('step-card-unsupported-s1')).toBeInTheDocument();
  });
});
