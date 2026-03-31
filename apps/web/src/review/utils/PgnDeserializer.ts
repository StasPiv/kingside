import { Chess } from 'chess.js';
import type { ChessMove } from '../types';
import { linkAllMovesRecursively } from './ChessHistoryUtils';
import { parseCommentMacros } from './commentMacros';

// Symbolic NAG annotations that can appear directly after a move in PGN
const SYMBOLIC_NAGS: Record<string, number> = {
  '!!': 3,
  '??': 4,
  '!?': 5,
  '?!': 6,
  '!': 1,
  '?': 2,
};

type Token =
  | { type: 'text'; value: string }
  | { type: 'nag'; value: number }
  | { type: 'comment'; value: string }
  | { type: 'paren'; value: '(' | ')' };

function tokenize(pgn: string): Token[] {
  // Remove ; line comments
  const cleaned = pgn.replace(/;[^\n]*/g, ' ');

  const tokens: Token[] = [];
  let i = 0;

  while (i < cleaned.length) {
    if (/\s/.test(cleaned[i])) {
      i++;
      continue;
    }

    // Block comment {text}
    if (cleaned[i] === '{') {
      const end = cleaned.indexOf('}', i + 1);
      if (end === -1) break;
      const commentText = cleaned.slice(i + 1, end).trim();
      if (commentText) {
        tokens.push({ type: 'comment', value: commentText });
      }
      i = end + 1;
      continue;
    }

    // Parentheses for variations
    if (cleaned[i] === '(' || cleaned[i] === ')') {
      tokens.push({ type: 'paren', value: cleaned[i] as '(' | ')' });
      i++;
      continue;
    }

    // NAG token $N
    if (cleaned[i] === '$') {
      let j = i + 1;
      while (j < cleaned.length && /\d/.test(cleaned[j])) {
        j++;
      }
      if (j > i + 1) {
        tokens.push({ type: 'nag', value: parseInt(cleaned.slice(i + 1, j), 10) });
        i = j;
        continue;
      }
    }

    // Read a word token (until whitespace, parens, braces, or $)
    let j = i;
    while (j < cleaned.length && !/[\s(){}$]/.test(cleaned[j])) {
      j++;
    }
    if (j > i) {
      const word = cleaned.slice(i, j);

      // First check if the entire token is a standalone symbolic NAG (!, !!, ?!, etc.)
      if (SYMBOLIC_NAGS[word] !== undefined) {
        tokens.push({ type: 'nag', value: SYMBOLIC_NAGS[word] });
      } else {
        // Check if the word ends with symbolic NAG (e.g., "e4!", "Nf3!?")
        // Try longest match first
        let nagFound = false;
        for (const sym of ['!!', '??', '!?', '?!', '!', '?']) {
          if (word.endsWith(sym) && word.length > sym.length) {
            const moveText = word.slice(0, -sym.length);
            tokens.push({ type: 'text', value: moveText });
            tokens.push({ type: 'nag', value: SYMBOLIC_NAGS[sym] });
            nagFound = true;
            break;
          }
        }

        if (!nagFound) {
          tokens.push({ type: 'text', value: word });
        }
      }
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
    let lastMove: ChessMove | null = null;

    while (pos < tokens.length) {
      const token = tokens[pos];

      // Handle end of variation or result
      if (token.type === 'paren' && token.value === ')') break;
      if (token.type === 'text' && isResult(token.value)) break;

      // Skip move numbers and continuation dots
      if (token.type === 'text' && (isMoveNumber(token.value) || isContinuationDots(token.value))) {
        pos++;
        continue;
      }

      // NAG token — attach to last move
      if (token.type === 'nag') {
        if (lastMove) {
          if (!lastMove.nags) lastMove.nags = [];
          lastMove.nags.push(token.value);
        }
        pos++;
        continue;
      }

      // Comment token — parse macros and attach to last move
      if (token.type === 'comment') {
        if (lastMove) {
          const parsed = parseCommentMacros(token.value);
          if (parsed.eval !== undefined) lastMove.eval = parsed.eval;
          if (parsed.clock !== undefined) lastMove.clock = parsed.clock;
          if (parsed.comment) {
            lastMove.comment = lastMove.comment
              ? lastMove.comment + ' ' + parsed.comment
              : parsed.comment;
          }
        }
        pos++;
        continue;
      }

      // Variation start
      if (token.type === 'paren' && token.value === '(') {
        pos++; // consume '('
        const beforeFen = lastMove ? lastMove.before : chess.fen();
        const varChess = new Chess(beforeFen);
        const variation = parseMoves(varChess, currentPly - 1);
        if (pos < tokens.length && tokens[pos].type === 'paren' && tokens[pos].value === ')') {
          pos++; // consume ')'
        }
        if (variation.length > 0 && lastMove) {
          if (!lastMove.variations) lastMove.variations = [];
          lastMove.variations.push(variation);
        }
        continue;
      }

      // Move token
      if (token.type === 'text') {
        const beforeFen = chess.fen();
        let chessMove;
        try {
          chessMove = chess.move(token.value);
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

        moves.push(move);
        lastMove = move;
        currentPly++;
        continue;
      }

      pos++;
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
