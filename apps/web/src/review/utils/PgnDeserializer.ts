import { Chess } from 'chess.js';
import type { ChessMove } from '../types';
import { linkAllMovesRecursively } from './ChessHistoryUtils';

function tokenize(pgn: string): string[] {
  // Remove { } comments and ; line comments
  const cleaned = pgn
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ');

  const tokens: string[] = [];
  let i = 0;

  while (i < cleaned.length) {
    if (/\s/.test(cleaned[i])) {
      i++;
      continue;
    }

    if (cleaned[i] === '(' || cleaned[i] === ')') {
      tokens.push(cleaned[i]);
      i++;
      continue;
    }

    // Read until whitespace or parenthesis
    let j = i;
    while (j < cleaned.length && !/[\s()]/.test(cleaned[j])) {
      j++;
    }
    if (j > i) {
      tokens.push(cleaned.slice(i, j));
    }
    i = j;
  }

  return tokens;
}

function isMoveNumber(token: string): boolean {
  return /^\d+\.+$/.test(token);
}

function isResult(token: string): boolean {
  return token === '*' || token === '1-0' || token === '0-1' || token === '1/2-1/2';
}

export function parseAnnotatedPgn(pgn: string): ChessMove[] {
  const tokens = tokenize(pgn);
  let pos = 0;
  let nextGlobalIndex = 0;

  function parseMoves(chess: Chess, startPly: number): ChessMove[] {
    const moves: ChessMove[] = [];
    let currentPly = startPly;

    while (pos < tokens.length) {
      const token = tokens[pos];

      if (token === ')' || isResult(token)) break;

      if (isMoveNumber(token)) {
        pos++;
        continue;
      }

      const beforeFen = chess.fen();
      let chessMove;
      try {
        chessMove = chess.move(token);
      } catch {
        break;
      }
      if (!chessMove) break;
      pos++;

      const afterFen = chess.fen();
      const move: ChessMove = {
        san: chessMove.san,
        fen: afterFen,
        from: chessMove.from,
        to: chessMove.to,
        piece: chessMove.piece,
        captured: chessMove.captured,
        promotion: chessMove.promotion,
        flags: chessMove.flags,
        lan: chessMove.from + chessMove.to + (chessMove.promotion ?? ''),
        before: beforeFen,
        after: afterFen,
        globalIndex: nextGlobalIndex++,
        ply: currentPly,
      };

      // Parse variations — alternatives to this move starting from the same position
      const variations: ChessMove[][] = [];
      while (pos < tokens.length && tokens[pos] === '(') {
        pos++; // consume '('
        const varChess = new Chess(beforeFen);
        const variation = parseMoves(varChess, currentPly);
        variations.push(variation);
        if (pos < tokens.length && tokens[pos] === ')') {
          pos++; // consume ')'
        }
      }

      if (variations.length > 0) {
        move.variations = variations;
      }

      moves.push(move);
      currentPly++;
    }

    return moves;
  }

  const chess = new Chess();
  const history = parseMoves(chess, 1);
  linkAllMovesRecursively(history);
  return history;
}
