import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../../test/test-utils';
import { TextStep, parseTextStepSegments } from './TextStep';
import type { TextStepPayload } from '@kingside/shared';

vi.mock('react-chessboard', () => ({
  Chessboard: (props: {
    options: {
      position?: string;
      boardOrientation?: string;
      arrows?: { startSquare: string; endSquare: string; color?: string }[];
      squareStyles?: Record<string, React.CSSProperties>;
    };
  }) => (
    <div
      data-testid="chessboard"
      data-fen={props.options.position}
      data-orientation={props.options.boardOrientation}
      data-arrows={JSON.stringify(props.options.arrows ?? null)}
      data-square-styles={JSON.stringify(props.options.squareStyles ?? null)}
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

describe('parseTextStepSegments — KS-1995 (arrows + highlightedSquares)', () => {
  it('пробрасывает arrows и highlightedSquares в FEN-сегмент через {{diagram:N}}', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '{{diagram:0}}',
      diagrams: [
        {
          fen: FEN_START,
          arrows: [{ from: 'd4', to: 'h8' }],
          highlightedSquares: [{ square: 'e4' }],
        },
      ],
    };
    const seg = parseTextStepSegments(payload).find((s) => s.kind === 'fen');
    expect(seg).toMatchObject({
      arrows: [{ from: 'd4', to: 'h8' }],
      highlightedSquares: [{ square: 'e4' }],
    });
  });

  it('orphan-диаграмма тоже сохраняет arrows / highlightedSquares', () => {
    const payload: TextStepPayload = {
      type: 'text',
      diagrams: [
        {
          fen: FEN_START,
          arrows: [{ from: 'a1', to: 'a8', color: '#ff0000' }],
        },
      ],
    };
    const seg = parseTextStepSegments(payload).find((s) => s.kind === 'fen');
    expect(seg?.arrows).toEqual([
      { from: 'a1', to: 'a8', color: '#ff0000' },
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
    // KS-1987: # → h1 (раньше был неправильный mapping # → h3).
    expect(md[0].innerHTML).toContain('<h1>Title</h1>');
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

  /**
   * KS-1891: при повторном открытии завершённого урока кнопка «Далее»
   * показывает «Done ✓» и получает класс-модификатор --done. Click
   * сохранён — markStep идемпотентен (KS-1879).
   */
  it('KS-1891 — stepState=done → кнопка «Done ✓» с классом --done', () => {
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Already passed' }}
        stepState="done"
      />,
    );
    const btn = screen.getByTestId('lesson-text-step-next');
    expect(btn.textContent).toContain('Done');
    expect(btn.className).toContain('lesson-text-step__next--done');
    expect(btn.getAttribute('data-step-state')).toBe('done');
  });

  it('KS-1891 — stepState=pending → обычная кнопка «Next», без --done', () => {
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Fresh' }}
        stepState="pending"
      />,
    );
    const btn = screen.getByTestId('lesson-text-step-next');
    expect(btn.textContent).toContain('Next');
    expect(btn.className).not.toContain('--done');
  });

  // ─── KS-1995: arrows + highlightedSquares ─────────────────────────

  it('KS-1995: arrows маппятся в формат react-chessboard (startSquare/endSquare/color)', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '{{diagram:0}}',
      diagrams: [
        {
          fen: FEN_START,
          arrows: [
            { from: 'd4', to: 'h8' },
            { from: 'e2', to: 'e4', color: '#ff0000' },
          ],
        },
      ],
    };
    renderWithProviders(<TextStep payload={payload} />);
    const board = screen.getByTestId('chessboard');
    const arrows = JSON.parse(board.getAttribute('data-arrows') ?? 'null');
    expect(arrows).toEqual([
      // дефолтный цвет, если backend не задал.
      { startSquare: 'd4', endSquare: 'h8', color: 'rgba(255, 153, 0, 0.85)' },
      { startSquare: 'e2', endSquare: 'e4', color: '#ff0000' },
    ]);
    expect(
      screen
        .getByTestId('lesson-text-step-diagram')
        .getAttribute('data-arrows'),
    ).toBe('2');
  });

  it('KS-1995: highlightedSquares маппятся в squareStyles', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '{{diagram:0}}',
      diagrams: [
        {
          fen: FEN_START,
          highlightedSquares: [
            { square: 'e4' },
            { square: 'd5', color: '#00ff00' },
          ],
        },
      ],
    };
    renderWithProviders(<TextStep payload={payload} />);
    const board = screen.getByTestId('chessboard');
    const styles = JSON.parse(board.getAttribute('data-square-styles') ?? 'null');
    expect(styles).toEqual({
      e4: { backgroundColor: 'rgba(255, 213, 0, 0.55)' },
      d5: { backgroundColor: '#00ff00' },
    });
    expect(
      screen
        .getByTestId('lesson-text-step-diagram')
        .getAttribute('data-highlights'),
    ).toBe('2');
  });

  it('KS-1995: без arrows/highlightedSquares → undefined в options (back-compat)', () => {
    const payload: TextStepPayload = {
      type: 'text',
      bodyMarkdown: '{{diagram:0}}',
      diagrams: [{ fen: FEN_START }],
    };
    renderWithProviders(<TextStep payload={payload} />);
    const board = screen.getByTestId('chessboard');
    expect(board.getAttribute('data-arrows')).toBe('null');
    expect(board.getAttribute('data-square-styles')).toBe('null');
  });

  it('KS-1891 — stepState отсутствует (back-compat) → обычная кнопка', () => {
    renderWithProviders(
      <TextStep payload={{ type: 'text', bodyMarkdown: 'Legacy' }} />,
    );
    const btn = screen.getByTestId('lesson-text-step-next');
    expect(btn.textContent).toContain('Next');
    expect(btn.className).not.toContain('--done');
    expect(btn.getAttribute('data-step-state')).toBe('pending');
  });

  it('KS-1891 — повторный клик по done-кнопке всё равно вызывает onStepDone (idempotent)', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Done' }}
        stepState="done"
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

/**
 * KS-1990: автомаркер `TEXT_STEP_AUTO_DONE_MS` удалён. Прогресс
 * шага засчитывается только по явному клику. Регрессия — убедиться
 * что после mount шаг остаётся pending без интерактива и реагирует
 * только на клик кнопки «Далее».
 */
describe('<TextStep> done только по клику (KS-1990)', () => {
  it('mount без клика → onStepDone не вызывается даже после задержки', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <TextStep payload={{ type: 'text', bodyMarkdown: 'Read me' }} onStepDone={onStepDone} />,
    );
    // Любая разумная задержка — авто-маркер был 1500ms.
    await new Promise((r) => setTimeout(r, 50));
    expect(onStepDone).not.toHaveBeenCalled();
  });

  it('клик «Далее» → onStepDone(1×)', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <TextStep payload={{ type: 'text', bodyMarkdown: 'click me' }} onStepDone={onStepDone} />,
    );
    fireEvent.click(screen.getByTestId('lesson-text-step-next'));
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('hideNext=true — кнопки нет, ни авто, ни клика, шаг остаётся pending', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <TextStep
        payload={{ type: 'text', bodyMarkdown: 'Last step body' }}
        onStepDone={onStepDone}
        hideNext
      />,
    );
    expect(screen.queryByTestId('lesson-text-step-next')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(onStepDone).not.toHaveBeenCalled();
  });
});
