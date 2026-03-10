import type { ChessMove } from '../types';

function serializeMoves(moves: ChessMove[]): string {
  const parts: string[] = [];
  let needBlackNumber = false;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const moveNumber = Math.ceil(move.ply / 2);
    const isWhiteMove = move.ply % 2 === 1;

    if (isWhiteMove) {
      parts.push(`${moveNumber}.`);
      needBlackNumber = false;
    } else if (i === 0 || needBlackNumber) {
      parts.push(`${moveNumber}...`);
      needBlackNumber = false;
    }

    parts.push(move.san);

    if (move.variations && move.variations.length > 0) {
      for (const variation of move.variations) {
        if (variation.length > 0) {
          parts.push(`(${serializeMoves(variation)})`);
          needBlackNumber = true;
        }
      }
    }
  }

  return parts.join(' ');
}

export function serializeToAnnotatedPgn(history: ChessMove[]): string {
  if (history.length === 0) return '*';
  return `${serializeMoves(history)} *`;
}
