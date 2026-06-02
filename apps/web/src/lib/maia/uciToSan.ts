/**
 * KS-3580. Конвертация UCI-хода (`e2e4`, `e7e8q`) в SAN (`e4`, `e8=Q`)
 * для отображения в UI fallback'а Maia. Если ход нелегален в данном FEN
 * (битый Maia top-3, защита) — возвращаем исходный UCI как есть.
 *
 * `chess.js` v1 умеет `move({from, to, promotion}, { strict: false })`
 * и отдаёт `move.san`. Дешевле работать на каждый ход (Chess instance —
 * лёгкий), но мы всё равно конвертим максимум 4-5 ходов на fallback.
 */
import { Chess } from 'chess.js';

export function uciToSan(fen: string, uci: string): string {
  if (uci.length < 4) return uci;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;

  try {
    const board = new Chess(fen);
    const move = board.move({ from, to, promotion });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}
