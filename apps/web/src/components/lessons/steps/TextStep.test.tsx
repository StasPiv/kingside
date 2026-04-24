import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../../test/test-utils';
import { TextStep, parseTextStepSegments } from './TextStep';
import type { TextStepPayload } from '@kingside/shared';

vi.mock('react-chessboard', () => ({
  Chessboard: (props: { options: { position?: string; boardOrientation?: string } }) => (
    <div
      data-testid="chessboard"
      data-fen={props.options.position}
      data-orientation={props.options.boardOrientation}
    />
  ),
}));

const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_CARO = 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

describe('parseTextStepSegments', () => {
  it('возвращает пустой массив для пустого payload', () => {
    expect(parseTextStepSegments({ type: 'text' })).toEqual([]);
  });

  it('разбирает reference-плейсхолдер {{diagram:0}} в FEN-сегмент', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: 'Before\n\n{{diagram:0}}\n\nAfter',
      diagrams: [{ fen: FEN_START, caption: 'Start', orientation: 'black' }],
    };
    const segments = parseTextStepSegments(payload);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: 'markdown' });
    expect(segments[1]).toMatchObject({
      kind: 'fen',
      fen: FEN_START,
      caption: 'Start',
      orientation: 'black',
    });
    expect(segments[2]).toMatchObject({ kind: 'markdown' });
  });

  it('пропускает битую ссылку {{diagram:N}}; declared-диаграмма остаётся orphan (рендерится в конец)', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: 'A\n\n{{diagram:99}}\n\nB',
      diagrams: [{ fen: FEN_START }],
    };
    const segments = parseTextStepSegments(payload);
    // Битая ссылка `{{diagram:99}}` вырезается, остаются markdown-куски
    // «A» и «B», а declared `diagrams[0]` дорисовывается orphan'ом в конец.
    const kinds = segments.map((s) => s.kind);
    expect(kinds).toEqual(['markdown', 'markdown', 'fen']);
    expect(segments[2]).toMatchObject({ kind: 'fen', fen: FEN_START });
  });

  it('orphan-диаграмма (declared, но без {{diagram:N}}-ссылки) рендерится в конец (KS-1827-bugfix)', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: 'Какой-то текст',
      diagrams: [{ fen: FEN_CARO, caption: 'orphan', orientation: 'black' }],
    };
    const segments = parseTextStepSegments(payload);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      kind: 'markdown',
      markdown: expect.stringMatching(/Какой-то текст/),
    });
    expect(segments[1]).toEqual({
      kind: 'fen',
      fen: FEN_CARO,
      caption: 'orphan',
      orientation: 'black',
    });
  });

  it('пустой markdown + declared-диаграммы → все рендерятся как orphan', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '',
      diagrams: [
        { fen: FEN_START },
        { fen: FEN_CARO, caption: 'caro' },
      ],
    };
    const segments = parseTextStepSegments(payload);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: 'fen', fen: FEN_START });
    expect(segments[1]).toMatchObject({ kind: 'fen', fen: FEN_CARO, caption: 'caro' });
  });

  it('частичная ссылка: одна диаграмма с {{diagram:0}}, вторая orphan', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: 'intro\n\n{{diagram:0}}\n\ntail',
      diagrams: [
        { fen: FEN_START, caption: 'referenced' },
        { fen: FEN_CARO, caption: 'orphan-second' },
      ],
    };
    const segments = parseTextStepSegments(payload);
    // intro → fen(0) → tail → fen(1 orphan)
    expect(segments.map((s) => s.kind)).toEqual(['markdown', 'fen', 'markdown', 'fen']);
    expect(segments[1]).toMatchObject({ fen: FEN_START, caption: 'referenced' });
    expect(segments[3]).toMatchObject({ fen: FEN_CARO, caption: 'orphan-second' });
  });

  it('разбирает inline ```fen``` блок с орientation и caption', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: [
        'Caro-Kann starts with:',
        '',
        '```fen black',
        FEN_CARO,
        'caption: After 1.e4 c6',
        '```',
        '',
        'White can continue with d4.',
      ].join('\n'),
    };
    const segments = parseTextStepSegments(payload);
    expect(segments).toHaveLength(3);
    expect(segments[1]).toEqual({
      kind: 'fen',
      fen: FEN_CARO,
      caption: 'After 1.e4 c6',
      orientation: 'black',
    });
  });

  it('inline ```fen``` без orientation → white по умолчанию', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: ['```fen', FEN_START, '```'].join('\n'),
    };
    const segments = parseTextStepSegments(payload);
    expect(segments).toEqual([
      { kind: 'fen', fen: FEN_START, caption: undefined, orientation: 'white' },
    ]);
  });
});

describe('<TextStep>', () => {
  it('рендерит markdown и FEN-доску из reference-плейсхолдера', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '# Title\n\nIntro paragraph.\n\n{{diagram:0}}\n\nAfter the diagram.',
      diagrams: [{ fen: FEN_START, caption: 'Initial position' }],
    };
    renderWithProviders(<TextStep payload={payload} />);
    expect(screen.getByTestId('lesson-text-step')).toBeInTheDocument();
    const md = screen.getAllByTestId('lesson-text-step-md');
    expect(md).toHaveLength(2);
    expect(md[0].innerHTML).toContain('<h3>Title</h3>');
    expect(md[0].innerHTML).toContain('Intro paragraph');

    const diagram = screen.getByTestId('lesson-text-step-diagram');
    expect(diagram).toHaveAttribute('data-fen', FEN_START);
    expect(diagram).toHaveTextContent('Initial position');

    const board = screen.getByTestId('chessboard');
    expect(board).toHaveAttribute('data-fen', FEN_START);
  });

  it('рендерит inline fenced FEN-блок', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: ['Look:', '', '```fen', FEN_CARO, '```'].join('\n'),
    };
    renderWithProviders(<TextStep payload={payload} />);
    const diagram = screen.getByTestId('lesson-text-step-diagram');
    expect(diagram).toHaveAttribute('data-fen', FEN_CARO);
  });

  it('кнопка «Далее» вызывает onStepDone', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Done?' }}
        onStepDone={onStepDone}
      />,
    );
    fireEvent.click(screen.getByTestId('lesson-text-step-next'));
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('hideNext скрывает кнопку «Далее»', () => {
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'No button' }}
        hideNext
      />,
    );
    expect(screen.queryByTestId('lesson-text-step-next')).toBeNull();
  });

  it('bodyI18nKey без bodyMarkdown показывает stub-параграф', () => {
    renderWithProviders(
      <TextStep payload={{ type: 'text', bodyI18nKey: 'lessons.title' }} />,
    );
    expect(screen.getByTestId('lesson-text-step-i18n-stub')).toHaveTextContent(
      'Lessons',
    );
  });
});
