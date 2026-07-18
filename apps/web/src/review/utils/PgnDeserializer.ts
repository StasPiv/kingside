import { Chess } from 'chess.js';
import type { ChessMove, NodeAnnotations } from '../types';
import { linkAllMovesRecursively, startPlyFromFen } from './ChessHistoryUtils';
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
  // KS-2032: НЕ предварительно вырезаем `;...\n` line-comments. По
  // PGN-стандарту `;` начинает line-comment только ВНЕ `{...}`-блока.
  // В авторских аннотациях (учебник Капабланки) `;` встречается как
  // обычный знак препинания внутри `{block-comment}`. Глобальный
  // `replace(/;[^\n]*/g, ' ')` съедал всё до перевода строки — вместе с
  // закрывающей `}` и всеми последующими ходами; партия рендерилась без
  // ходов. Теперь `;` обрабатывается на основном проходе ниже, и попадёт
  // под line-comment ТОЛЬКО если мы не внутри `{...}` (block-comment
  // ниже потребляет всё до своей `}` и сам никогда не оставляет `;`
  // основному циклу).
  const cleaned = pgn;

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

    // Line comment `;...\n` — outside of `{...}` only (см. KS-2032).
    if (cleaned[i] === ';') {
      let j = i + 1;
      while (j < cleaned.length && cleaned[j] !== '\n') j++;
      i = j;
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

/**
 * KS-2035: вытащить leading-комментарий PGN — все `{...}`-блоки,
 * стоящие ПЕРЕД первым ходом (между tag-pair'ами и `1.<move>`). По
 * стандарту PGN такой комментарий привязан к стартовой позиции и
 * описывает партию в целом (вступление автора, постановка позиции).
 *
 * `parseAnnotatedPgn` хранит комментарии только привязанными к
 * предыдущему ходу — leading-комментарий «теряется», потому что
 * `lastMove === null`. Этот хелпер живёт отдельно: вытаскивает все
 * pre-move `{...}` (если их несколько — склеивает через пробел) и
 * возвращает строку, либо `undefined` если их нет.
 *
 * Логика идёт по тем же правилам, что `tokenize`:
 *  - `[...]` tag-pairs убираются построчно;
 *  - `;`-line-comment пропускается до `\n`;
 *  - `{...}`-block-comment накапливается в `parts`;
 *  - любой не-whitespace, не-comment символ — это уже SAN/move-number,
 *    останавливаемся.
 */
export function extractLeadingComment(pgn: string): string | undefined {
  if (!pgn) return undefined;
  const withoutHeaders = pgn.replace(/^\[.*\]\s*$/gm, '');
  const parts: string[] = [];
  let i = 0;
  while (i < withoutHeaders.length) {
    const ch = withoutHeaders[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === ';') {
      while (i < withoutHeaders.length && withoutHeaders[i] !== '\n') i++;
      continue;
    }
    if (ch === '{') {
      const end = withoutHeaders.indexOf('}', i + 1);
      if (end === -1) break;
      const text = withoutHeaders.slice(i + 1, end).trim();
      if (text) parts.push(text);
      i = end + 1;
      continue;
    }
    // Любой другой символ — уже move-related (SAN, move-number, NAG,
    // вариация). Дальше парсить leading-comment не имеет смысла.
    break;
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * KS-2152: распарсить leading-комментарий PGN (см. extractLeadingComment)
 * на предмет наших аннотаций для стартовой позиции [%csl]/[%cal].
 * Возвращает annotations или undefined если их там нет.
 */
export function extractInitialAnnotations(pgn: string): NodeAnnotations | undefined {
  const lead = extractLeadingComment(pgn);
  if (!lead) return undefined;
  const parsed = parseCommentMacros(lead);
  return parsed.annotations;
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
          // KS-2152: восстанавливаем annotations из [%csl]/[%cal].
          if (parsed.annotations) {
            const existing = lastMove.annotations ?? {};
            lastMove.annotations = {
              ...existing,
              ...(parsed.annotations.highlights && { highlights: parsed.annotations.highlights }),
              ...(parsed.annotations.arrows && { arrows: parsed.annotations.arrows }),
            };
          }
          // KS-2286 (ADR-038 §4): [%cvc X] → move.variationColor.
          // Хранится на comment первого хода варианта; парсер не знает,
          // «голова» это вариации или нет — кладёт всем, у кого встретил
          // макрос. SET_VARIATION_COLOR в reducer'е (KS-2287) /
          // render-override (KS-2288) сами фильтруют по позиции.
          if (parsed.variationColor) {
            lastMove.variationColor = parsed.variationColor;
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
  // KS-4983: startPly из fullmove-счётчика FEN — общий хелпер (та же
  // формула теперь и в useReviewState для пути «вставка FEN»).
  const startPly = startFen ? startPlyFromFen(startFen) : 1;
  const history = parseMoves(chess, startPly);
  linkAllMovesRecursively(history);
  return history;
}
