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

function isContinuationDots(token: string): boolean {
  return /^\.{2,}$/.test(token);
}

function isResult(token: string): boolean {
  return token === '*' || token === '1-0' || token === '0-1' || token === '1/2-1/2';
}

export function parseAnnotatedPgn(pgn: string): ChessMove[] {
  // Extract FEN header if present
  const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/);
  const startFen = fenMatch ? fenMatch[1] : undefined;

  // Strip PGN tag pairs (lines like [White "Name"]) before tokenizing
  const withoutHeaders = pgn.replace(/^\[.*\]\s*$/gm, '');
  const tokens = tokenize(withoutHeaders);
  let pos = 0;
  let nextGlobalIndex = 0;

  function parseMoves(chess: Chess, startPly: number): ChessMove[] {
    const moves: ChessMove[] = [];
    let currentPly = startPly;

    while (pos < tokens.length) {
      const token = tokens[pos];

      if (token === ')' || isResult(token)) break;

      if (isMoveNumber(token) || isContinuationDots(token)) {
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

  const chess = startFen ? new Chess(startFen) : new Chess();
  // Compute starting ply from FEN (fullmove number * 2 - (white=1, black=0))
  const startPly = startFen
    ? (() => {
        const parts = startFen.split(' ');
        const fullmove = parseInt(parts[5] || '1', 10);
        const isBlack = parts[1] === 'b';
        return (fullmove - 1) * 2 + (isBlack ? 2 : 1);
      })()
    : 1;
  const history = parseMoves(chess, startPly);
  linkAllMovesRecursively(history);
  return history;
}
