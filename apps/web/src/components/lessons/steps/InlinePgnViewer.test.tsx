import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { InlinePgnViewer } from './InlinePgnViewer';

vi.mock('react-chessboard', () => ({
  Chessboard: (props: {
    options: {
      position?: string;
      squareStyles?: Record<string, React.CSSProperties>;
    };
  }) => (
    <div
      data-testid="chessboard"
      data-fen={props.options.position}
      data-square-styles={JSON.stringify(props.options.squareStyles ?? null)}
    />
  ),
}));

const SHORT_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 *';

const FROM_FEN_PGN =
  '[Event "Mate"]\n[FEN "7k/8/8/8/8/8/8/R6K w - - 0 1"]\n[SetUp "1"]\n\n1. Ra8# 1-0';

const ANNOTATED_PGN =
  '1. e4 {Главный ход — занимаем центр.} e5 $1 2. Nf3?! {Поспешно.} Nc6 *';

describe('<InlinePgnViewer>', () => {
  it('парсит PGN и стартует на ply=0 (стартовая позиция)', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    const root = screen.getByTestId('inline-pgn-viewer');
    expect(root.getAttribute('data-state')).toBe('ready');
    expect(root.getAttribute('data-ply')).toBe('0');
    // 5 plies (3 хода белых + 2 чёрных).
    expect(screen.getByTestId('inline-pgn-viewer-counter').textContent).toBe(
      '0/5',
    );
  });

  it('кнопка next перемещает на следующий ply, last — в конец', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-last'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('5/5');
    // На последнем ply кнопки next/last выключены, prev/first — нет.
    expect(
      (screen.getByTestId('inline-pgn-viewer-next') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('inline-pgn-viewer-last') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('клик по ходу в нотации прыгает на этот ply, помечает текущим', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    // 3-й ход (globalIndex=2) = Nf3.
    fireEvent.click(screen.getByTestId('review-move-2'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('3/5');
    expect(
      screen.getByTestId('review-move-2').getAttribute('data-current'),
    ).toBe('true');
    // Другие ходы — не current.
    expect(
      screen.getByTestId('review-move-0').getAttribute('data-current'),
    ).toBe('false');
  });

  it('подсветка last-move: squareStyles на from/to после next', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    const board = screen.getByTestId('chessboard');
    const styles = JSON.parse(board.getAttribute('data-square-styles') ?? 'null');
    // 1.e4 → from e2, to e4.
    expect(styles).toMatchObject({
      e2: { backgroundColor: expect.stringMatching(/rgba/) },
      e4: { backgroundColor: expect.stringMatching(/rgba/) },
    });
  });

  it('PGN с тегом [FEN ...] стартует с этой позиции', () => {
    renderWithProviders(<InlinePgnViewer pgn={FROM_FEN_PGN} />);
    const board = screen.getByTestId('chessboard');
    expect(board.getAttribute('data-fen')).toBe(
      '7k/8/8/8/8/8/8/R6K w - - 0 1',
    );
    // 1 ход → counter «0/1».
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('0/1');
  });

  it('пустой/невалидный PGN → fallback "не удалось разобрать"', () => {
    renderWithProviders(<InlinePgnViewer pgn="" />);
    expect(
      screen.getByTestId('inline-pgn-viewer').getAttribute('data-state'),
    ).toBe('error');
  });

  it('клавиша → листает на следующий ход, ← на предыдущий', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    const root = screen.getByTestId('inline-pgn-viewer');
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('2/5');
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
  });

  // KS-2005: примечания и NAG'и — основная мотивация переезда на ReviewMoveList.

  it('PGN-комментарий к ходу рендерится в нотации (через ReviewMoveList)', () => {
    renderWithProviders(<InlinePgnViewer pgn={ANNOTATED_PGN} />);
    // Комментарий «Главный ход — занимаем центр.» привязан к ходу 0 (e4).
    const cmt = screen.getByTestId('review-comment-0');
    expect(cmt.textContent).toContain('Главный ход');
    // На ходе 2 (Nf3) комментарий «Поспешно.»
    expect(screen.getByTestId('review-comment-2').textContent).toContain(
      'Поспешно',
    );
  });

  it('NAG-аннотации (!, ?!, $1) рендерятся рядом с ходом', () => {
    renderWithProviders(<InlinePgnViewer pgn={ANNOTATED_PGN} />);
    // e5 $1 — символ «!» в spans класса review-nag.
    const e5 = screen.getByTestId('review-move-1');
    expect(e5.textContent).toContain('!');
    // Nf3?! — символ «?!».
    const nf3 = screen.getByTestId('review-move-2');
    expect(nf3.textContent).toContain('?!');
  });

  it('крупный блок текущего комментария под доской — есть только когда у текущего хода есть комментарий', () => {
    renderWithProviders(<InlinePgnViewer pgn={ANNOTATED_PGN} />);
    // На ply=0 текущего хода нет → блок не рендерится.
    expect(
      screen.queryByTestId('inline-pgn-viewer-current-comment'),
    ).toBeNull();
    // После next → текущий ход e4 c комментарием.
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    expect(
      screen.getByTestId('inline-pgn-viewer-current-comment').textContent,
    ).toContain('Главный ход');
    // Ещё next → e5 ($1, без комментария) — блок снова исчезает.
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    expect(
      screen.queryByTestId('inline-pgn-viewer-current-comment'),
    ).toBeNull();
  });

  it('обычный PGN без комментариев — блок текущего комментария никогда не рендерится', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-last'));
    expect(
      screen.queryByTestId('inline-pgn-viewer-current-comment'),
    ).toBeNull();
  });

  // KS-2032: `;` внутри `{block-comment}` — обычный знак препинания, не
  // PGN line-comment. До фикса предварительный `replace(/;[^\n]*/g, ' ')`
  // съедал всё до перевода строки — вместе с закрывающей `}` блока и
  // всеми ходами, и партия рендерилась как «0/0 ходов».
  it('PGN с `;` внутри блок-комментария → ходы парсятся корректно (regression KS-2032)', () => {
    const pgn = [
      '[FEN "8/8/8/8/4k3/8/3KP3/8 w - - 0 1"]',
      '[SetUp "1"]',
      '',
      '{Способ защиты: держать короля перед пешкой; если же это невозможно, держаться напротив белого короля.} 1. e3 Ke5 2. Kd3 Kd5 1/2-1/2',
    ].join('\n');
    renderWithProviders(<InlinePgnViewer pgn={pgn} />);
    const root = screen.getByTestId('inline-pgn-viewer');
    expect(root.getAttribute('data-state')).toBe('ready');
    // 4 plies (e3, Ke5, Kd3, Kd5).
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('0/4');
  });
});
