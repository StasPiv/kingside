/**
 * KS-2754. Тесты `<PrecisionAttemptReview>`.
 *
 * Покрытие:
 *  1. Полная партия (3 user + 3 engine) с правильной SAN-нумерацией —
 *     user играет чёрными, начало с `... b - - N 22`.
 *  2. Не-best user-ход → блок «Лучше: <SAN>, W/D/L%» (WDL distribution).
 *  3. Best user-ход → блок «Лучше» не рендерится.
 *  4. engineUci=null (legacy) → engine-полуход НЕ рисуется (никаких
 *     fallback-реконструкций).
 *  5. wdlBefore=null → annotation «Лучше» не рисуется даже если ход
 *     не best (cp-фоллбэка нет).
 *  6. Первый user-ход чёрных → префикс `22...`.
 *  7. Клик по ходу → onSelectMove получает fenBefore.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrecisionMoveDto } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionAttemptReview } from './PrecisionAttemptReview';

/**
 * Простой helper для построения PrecisionMoveDto.
 * Все UCI / FEN'ы должны быть валидными — chess.js используется внутри.
 */
function move(over: Partial<PrecisionMoveDto>): PrecisionMoveDto {
  return {
    ply: 1,
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4',
    bestUci: 'e2e4',
    cpBefore: 30,
    cpAfter: 30,
    wdlBefore: { w: 500, d: 400, l: 100 },
    wdlAfter: { w: 500, d: 400, l: 100 },
    depth: 18,
    classification: 'best',
    engineUci: 'e7e5',
    ...over,
  };
}

describe('<PrecisionAttemptReview>', () => {
  it('полная партия 3 user + 3 engine рендерится с правильной нумерацией', () => {
    // Стартовая позиция: белые играют от старта (movenum=1).
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // После 1.e4: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
    // После 1...e5: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
    // После 2.Nf3: ... b KQkq - 1 2
    // После 2...Nc6: ... w KQkq - 2 3
    // После 3.Bc4: ... b - - 3 3
    const moves: PrecisionMoveDto[] = [
      move({
        ply: 1,
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        engineUci: 'e7e5',
        classification: 'best',
      }),
      move({
        ply: 3,
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
        playedUci: 'g1f3',
        bestUci: 'g1f3',
        engineUci: 'b8c6',
        classification: 'best',
      }),
      move({
        ply: 5,
        fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        playedUci: 'f1c4',
        bestUci: 'f1c4',
        engineUci: null, // последний user-полуход без ответа движка
        classification: 'best',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview
        initialFen={fen0}
        moves={moves}
        userSide="w"
      />,
    );

    expect(screen.getByTestId('precision-attempt-review')).toBeTruthy();

    // SAN — 5 ходов (3 user + 2 engine; третий engineUci=null). User
    // ходы с classification='best' идут с NAG=`!`, engine ходы без NAG.
    expect(screen.getByTestId('precision-attempt-review-move-0').textContent)
      .toBe('e4!');
    expect(screen.getByTestId('precision-attempt-review-move-1').textContent)
      .toBe('e5');
    expect(screen.getByTestId('precision-attempt-review-move-2').textContent)
      .toBe('Nf3!');
    expect(screen.getByTestId('precision-attempt-review-move-3').textContent)
      .toBe('Nc6');
    expect(screen.getByTestId('precision-attempt-review-move-4').textContent)
      .toBe('Bc4!');
    // Пятого хода (engine на третий user) нет — engineUci=null.
    expect(screen.queryByTestId('precision-attempt-review-move-5')).toBeNull();

    // Нумерация. PGN-токены движка/юзера: 1. e4! e5 2. Nf3! Nc6 3. Bc4!
    const pgn = screen.getByTestId('precision-attempt-review-pgn').textContent ?? '';
    expect(pgn).toMatch(/1\.\s*e4!/);
    expect(pgn).toMatch(/2\.\s*Nf3!/);
    expect(pgn).toMatch(/3\.\s*Bc4!/);
  });

  it('не-best user-ход → рендерит «Лучше: <SAN>, W/D/L%»', () => {
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'a2a3',
        bestUci: 'e2e4',
        wdlBefore: { w: 730, d: 200, l: 70 },
        engineUci: 'e7e5',
        classification: 'mistake',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview initialFen={fen0} moves={moves} userSide="w" />,
    );

    const best = screen.getByTestId('precision-attempt-review-best-0');
    expect(best).toBeTruthy();
    expect(best.textContent).toContain('e4');
    expect(best.textContent).toContain('73/20/7%');
  });

  it('best user-ход → блок «Лучше» НЕ рендерится', () => {
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        classification: 'best',
        engineUci: 'e7e5',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview initialFen={fen0} moves={moves} userSide="w" />,
    );

    expect(screen.queryByTestId('precision-attempt-review-best-0')).toBeNull();
  });

  it('engineUci=null в середине партии → engine-полуход НЕ рисуется', () => {
    // Legacy attempt: первый user сделал ход, но engineUci не сохранён.
    // Следующий user-ход всё равно должен отрисоваться корректно из
    // своего fenBefore — без попыток реконструировать ход движка.
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const fen1AfterEngine =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        engineUci: null, // ← legacy
        classification: 'best',
      }),
      move({
        fenBefore: fen1AfterEngine,
        playedUci: 'g1f3',
        bestUci: 'g1f3',
        engineUci: null,
        classification: 'best',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview initialFen={fen0} moves={moves} userSide="w" />,
    );

    // Только 2 user-хода. Engine-полуходов нет.
    expect(screen.getByTestId('precision-attempt-review-move-0').textContent)
      .toBe('e4!');
    expect(screen.getByTestId('precision-attempt-review-move-1').textContent)
      .toBe('Nf3!');
    expect(screen.queryByTestId('precision-attempt-review-move-2')).toBeNull();
  });

  it('wdlBefore=null → «Лучше» НЕ рендерится даже если ход не best (без cp-фоллбэка)', () => {
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'a2a3',
        bestUci: 'e2e4',
        wdlBefore: null,
        cpBefore: 200, // cp есть, но мы намеренно не используем как fallback
        classification: 'mistake',
        engineUci: 'e7e5',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview initialFen={fen0} moves={moves} userSide="w" />,
    );

    expect(screen.queryByTestId('precision-attempt-review-best-0')).toBeNull();
  });

  it('первый ход чёрных → префикс «N...»', () => {
    // Позиция, в которой чёрные начинают ходить с movenum=22:
    const fen0 = '4r1k1/5p2/4p1p1/8/2P5/4P1P1/r4PKP/3R4 b - - 0 22';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'g6g5',
        bestUci: 'g6g5',
        engineUci: null,
        classification: 'best',
      }),
    ];

    renderWithProviders(
      <PrecisionAttemptReview initialFen={fen0} moves={moves} userSide="b" />,
    );

    const pgn = screen.getByTestId('precision-attempt-review-pgn').textContent ?? '';
    expect(pgn).toMatch(/22\.\.\.\s*g5/);
  });

  it('клик по ходу → onSelectMove получает fenBefore', () => {
    const fen0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves: PrecisionMoveDto[] = [
      move({
        fenBefore: fen0,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        engineUci: 'e7e5',
        classification: 'best',
      }),
    ];

    const onSelectMove = vi.fn();
    renderWithProviders(
      <PrecisionAttemptReview
        initialFen={fen0}
        moves={moves}
        userSide="w"
        onSelectMove={onSelectMove}
      />,
    );

    const btn = screen.getByTestId('precision-attempt-review-move-0');
    btn.click();
    expect(onSelectMove).toHaveBeenCalledWith({ fenBefore: fen0 });
  });
});
