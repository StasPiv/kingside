import { Chess } from 'chess.js';
import type { EvalLine } from '../hooks/useStockfish';

export function formatEval(line: EvalLine, isBlackTurn = false): string {
  const sign = isBlackTurn ? -1 : 1;
  if (line.score.type === 'mate') {
    const mateValue = sign * line.score.value;
    return mateValue === 0 ? '#' : `M${Math.abs(mateValue)}`;
  }
  const cp = (sign * line.score.value) / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(2);
}

export function evalToPercent(lines: EvalLine[], isBlackTurn: boolean): number {
  if (lines.length === 0) return 50;
  const line = lines[0];
  const sign = isBlackTurn ? -1 : 1;
  if (line.score.type === 'mate') {
    const mateValue = sign * line.score.value;
    return mateValue > 0 ? 95 : mateValue < 0 ? 5 : 50;
  }
  const cp = sign * line.score.value;
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  return Math.max(2, Math.min(98, pct));
}

export function formatPv(pv: string, fen: string): string {
  try {
    const chess = new Chess(fen);
    const uciMoves = pv.split(' ');
    const fenParts = fen.split(' ');
    let isWhiteTurn = fenParts[1] === 'w';
    let moveNumber = parseInt(fenParts[5] || '1', 10);
    const parts: string[] = [];
    for (const uci of uciMoves.slice(0, 20)) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      let move;
      try {
        move = chess.move({ from, to, promotion });
      } catch {
        break;
      }
      if (!move) break;
      if (isWhiteTurn) {
        parts.push(`${moveNumber}. ${move.san}`);
      } else if (parts.length === 0) {
        parts.push(`${moveNumber}... ${move.san}`);
      } else {
        parts.push(move.san);
      }
      if (!isWhiteTurn) moveNumber++;
      isWhiteTurn = !isWhiteTurn;
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

/**
 * KS-2521 / KS-2528 (legacy fallback). WDL_signed (домен `[-1..+1]`,
 * либо lichess-сигмоида от cp, либо backend-сериализация
 * `(W − L)/1000`) → шансы на победу в процентах (целое 0..100).
 *
 * Линейный mapping: `pct = ((wdl + 1) / 2) * 100` → +1 = 100%, 0 = 50%,
 * −1 = 0%. Округление через `Math.round`; `Math.max/min` clamp защищает
 * от внеграничных входов (mate-fallback, переразгон сигмоиды).
 *
 * Используется на fallback-пути summary, когда у пазла нет
 * полных Wdl-объектов (legacy / Bridge без WDL-патча, см. KS-2521/KS-2528).
 */
export function wdlSignedToWinChancePercent(wdl: number): number {
  const pct = ((wdl + 1) / 2) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * KS-2528: per-mille (0..1000) → проценты (целое 0..100). Округление
 * через `Math.round(n / 10)`; clamp защищает от выпадов за диапазон.
 */
export function permilleToPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n / 10)));
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
