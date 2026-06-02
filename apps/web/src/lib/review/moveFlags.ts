/**
 * KS-3610 (ADR-101). Хелпер: forcing-move определение для логики
 * продления stabilized variation (`buildStabilizedLine` через
 * forcing-move'ы идёт ещё на 1 полуход).
 *
 * Используем `chess.js`: разбираем UCI-ход на `fen`, смотрим SAN'у
 * и флаги объекта Move. `+`/`#` в SAN → check, `flags` поле содержит
 * `c` (capture) или `e` (en-passant capture).
 */
import { Chess } from 'chess.js';

export function isCheckOrCapture(fen: string, uci: string): boolean {
  if (!uci || uci.length < 4) return false;
  try {
    const board = new Chess(fen);
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (!move) return false;
    // chess.js v1: `flags` строка — `c` (capture), `e` (en-passant),
    // SAN-маркеры `+`/`#` — мат/шах. Проверяем оба варианта.
    const flags = (move.flags ?? '').toString();
    if (flags.includes('c') || flags.includes('e')) return true;
    const san = move.san ?? '';
    if (san.includes('+') || san.includes('#') || san.includes('x')) return true;
    return false;
  } catch {
    return false;
  }
}
