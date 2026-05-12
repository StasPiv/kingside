import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';

import { buildPuzzleAnalysisPgn } from './buildPuzzleAnalysisPgn';

/**
 * KS-2606 (ADR-051 §4 B4): тесты сборщика PGN для кнопки «Анализ» на
 * PuzzlePage. Ключевое условие — итоговая позиция после применения PGN
 * должна совпадать с финальной позицией пазла (FEN после всех ходов
 * решения), чтобы AnalysisPage показал ровно её.
 */
describe('buildPuzzleAnalysisPgn (KS-2606)', () => {
  it('white-to-move + 4 хода: PGN с FEN-header и нумерацией с N.', () => {
    // Pin Бенко: позиция, в которой ход белых.
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5';
    const moves = ['e1g1', 'e8g8', 'b1c3', 'd7d6'];
    const pgn = buildPuzzleAnalysisPgn(fen, moves);

    // Header: SetUp + FEN + пустая строка + ходы (KS-2828: парная связка).
    expect(pgn).toMatch(/^\[SetUp "1"\]\n\[FEN "[^"]+"\]\n\n/);
    expect(pgn).toContain('5. O-O O-O 6. Nc3 d6');

    // Финальная позиция совпадает с применением UCI-ходов к стартовой FEN.
    const final = applyUciMoves(fen, moves);
    expect(replayPgn(pgn).fen()).toBe(final.fen());
  });

  it('black-to-move + 3 хода: первая запись — N... <san>', () => {
    // Позиция, где ход чёрных (после 1.e4).
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const moves = ['e7e5', 'g1f3', 'b8c6'];
    const pgn = buildPuzzleAnalysisPgn(fen, moves);

    expect(pgn).toContain('1... e5 2. Nf3 Nc6');
    expect(replayPgn(pgn).fen()).toBe(applyUciMoves(fen, moves).fen());
  });

  it('moves в виде строки через пробел (как из API)', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const movesStr = 'e7e5 g1f3 b8c6';
    const pgn = buildPuzzleAnalysisPgn(fen, movesStr);
    expect(pgn).toContain('1... e5 2. Nf3 Nc6');
  });

  it('promotion: UCI с 5-м символом (e7e8q) → SAN с `=Q`', () => {
    // Чисто пешечное окончание: белая пешка перед превращением.
    const fen = '8/4P3/8/8/8/8/8/k1K5 w - - 0 1';
    const moves = ['e7e8q'];
    const pgn = buildPuzzleAnalysisPgn(fen, moves);
    expect(pgn).toContain('e8=Q');
    expect(replayPgn(pgn).fen()).toBe(applyUciMoves(fen, moves).fen());
  });

  it('пустой список ходов → PGN только с FEN/SetUp-header (без ходов)', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const pgn = buildPuzzleAnalysisPgn(fen, []);
    expect(pgn).toBe(`[SetUp "1"]\n[FEN "${fen}"]\n\n`);
  });

  it('битый ход в середине списка — обрыв, ранее собранные ходы сохраняются', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // 2-й ход — нелегальный (e2e4 уже сыгран; e2e5 — illegal).
    const moves = ['e2e4', 'e2e5', 'g1f3'];
    const pgn = buildPuzzleAnalysisPgn(fen, moves);
    expect(pgn).toContain('1. e4');
    expect(pgn).not.toContain('Nf3');
  });

  it('FEN с произвольным `fullmoveNumber` (не 1) — нумерация продолжается', () => {
    // Промежуточная позиция середины игры; полный номер хода = 8.
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 8';
    const moves = ['e1g1', 'e8g8'];
    const pgn = buildPuzzleAnalysisPgn(fen, moves);
    expect(pgn).toContain('8. O-O O-O');
  });
});

// --- helpers ---

function applyUciMoves(fen: string, moves: string[]): Chess {
  const c = new Chess(fen);
  for (const uci of moves) {
    c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4],
    });
  }
  return c;
}

function replayPgn(pgn: string): Chess {
  const c = new Chess();
  c.loadPgn(pgn);
  return c;
}
