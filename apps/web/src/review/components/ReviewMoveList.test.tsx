import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { ReviewMoveList } from './ReviewMoveList';
import type { ChessMove } from '../types';

/**
 * KS-2266 (ADR-037 §6) — категорийная дедупликация NAG в UI.
 *
 * До фикса: правый клик `!!` после `!` давал `nags = [1, 3]`
 * (рендерилось как `! !!`). После фикса: setNagInCategory заменяет
 * NAG внутри категории `quality`, у хода остаётся ровно `[3]`.
 *
 * Покрытие:
 *  - replace within group: nags=[1] + клик `!!` → onSetNag(idx, [3]).
 *  - toggle off: nags=[3] + клик `!!` → onSetNag(idx, []).
 *  - cross-category coexistence: nags=[1, 14] + клик `!!` → [14, 3].
 *  - renderNagSymbols показывает по одному NAG категории даже при
 *    legacy-данных с дублями (`[1, 3]` → видим только `!!`).
 */

function makeMove(overrides: Partial<ChessMove> = {}): ChessMove {
  return {
    san: 'e4',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    from: 'e2',
    to: 'e4',
    piece: 'p',
    flags: 'b',
    lan: 'e2e4',
    before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    globalIndex: 1,
    ply: 1,
    ...overrides,
  };
}

beforeEach(() => {
  // Чтобы скроллы из useEffect не падали в jsdom/happy-dom.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ReviewMoveList> KS-2266 — NAG категорийная дедупликация', () => {
  it('replace within quality: [1] + клик "!!" → onSetNag(idx, [3])', async () => {
    const onSetNag = vi.fn();
    const move = makeMove({ nags: [1] }); // `!`
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    const moveEl = screen.getByTestId('review-move-1');
    fireEvent.contextMenu(moveEl);

    const user = userEvent.setup();
    const nagBtn = document.querySelector('button[data-nag="3"]') as HTMLButtonElement;
    expect(nagBtn).not.toBeNull();
    await user.click(nagBtn);

    expect(onSetNag).toHaveBeenCalledTimes(1);
    expect(onSetNag).toHaveBeenCalledWith(1, [3]);
  });

  it('toggle off: [3] + клик "!!" → onSetNag(idx, [])', async () => {
    const onSetNag = vi.fn();
    const move = makeMove({ nags: [3] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    const user = userEvent.setup();
    await user.click(document.querySelector('button[data-nag="3"]') as HTMLButtonElement);

    expect(onSetNag).toHaveBeenCalledWith(1, []);
  });

  it('cross-category coexistence: [1, 14] + клик "!!" → [14, 3]', async () => {
    const onSetNag = vi.fn();
    // 14 — position-eval `⩲`, не из quality-категории.
    const move = makeMove({ nags: [1, 14] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    const user = userEvent.setup();
    await user.click(document.querySelector('button[data-nag="3"]') as HTMLButtonElement);

    expect(onSetNag).toHaveBeenCalledWith(1, [14, 3]);
  });

  it('renderNagSymbols показывает по одному NAG категории (legacy [1, 3] → видим только "!!")', () => {
    // Симулируем legacy-данные с дублями quality-NAG (`[1, 3]`).
    const move = makeMove({ nags: [1, 3] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );

    const moveEl = screen.getByTestId('review-move-1');
    // Видим только последний quality-NAG категории.
    expect(moveEl).toHaveTextContent('!!');
    // Не видим пары `! !!` или `! !`.
    expect(moveEl.textContent).not.toMatch(/! !!/);
  });

  it('renderNagSymbols: один quality + один positionEval inline ([1, 14] → "! ⩲")', () => {
    const move = makeMove({ nags: [1, 14] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    const moveEl = screen.getByTestId('review-move-1');
    // Оба NAG (по одному из каждой категории) видны.
    expect(moveEl.textContent).toContain('!');
    expect(moveEl.textContent).toContain('⩲');
  });
});
