import type { ChessMove } from '../types';
import { serializeCommentWithMacros } from './commentMacros';

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

    // Serialize NAGs
    if (move.nags && move.nags.length > 0) {
      for (const nag of move.nags) {
        parts.push(`$${nag}`);
      }
    }

    // Serialize comment (including eval/clock macros)
    const fullComment = serializeCommentWithMacros(move.comment, move.eval, move.clock);
    if (fullComment) {
      parts.push(`{${fullComment}}`);
    }

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
