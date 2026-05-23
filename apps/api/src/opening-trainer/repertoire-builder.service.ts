import { Injectable } from '@nestjs/common';
import { Chess } from 'chess.js';
import {
  OPENING_REPERTOIRE_LIMITS,
  type RepertoireEdge,
  type RepertoireNode,
  type RepertoireTree,
} from '@kingside/shared';

/**
 * KS-3271 (ADR-077 §2.2, §5.2). Парсит исходный PGN (с вложенными
 * вариантами) в `RepertoireTree` — FEN-keyed dict с edge'ами.
 * Транспозиции схлопываются: одна позиция (по FEN) = один node,
 * даже если до неё ведут несколько путей.
 *
 * Реализация: собственный токенайзер `()`-вариантов поверх chess.js
 * (chess.js 1.x НЕ парсит variation tree через `loadPgn`, только
 * main-line). Для каждого SAN-хода используем `chess.move(san)` →
 * получаем UCI + childFen. Чистая функция, без I/O — тестируется
 * фикстурами без TestingModule.
 *
 * Ограничения (ADR §3.2 / shared `OPENING_REPERTOIRE_LIMITS`):
 *   - размер PGN ≤ 500 KB
 *   - nodes ≤ 2000, edges ≤ 5000, depth ≤ 80 полуходов
 * Превышение — `RepertoireLimitExceededError` (caller возвращает 400).
 *
 * Битый PGN (несбалансированные скобки, illegal SAN, пустой movetext)
 * — `RepertoirePgnError` с человекочитаемым сообщением (caller тоже
 * возвращает 400 с этим текстом).
 */

export class RepertoirePgnError extends Error {
  readonly code = 'REPERTOIRE_PGN_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RepertoirePgnError';
  }
}

export type RepertoireLimitKind = 'pgn-size' | 'nodes' | 'edges' | 'depth';

export class RepertoireLimitExceededError extends Error {
  readonly code = 'REPERTOIRE_LIMIT_EXCEEDED' as const;
  constructor(
    public readonly limit: RepertoireLimitKind,
    public readonly actual: number,
    public readonly max: number,
  ) {
    super(
      `Repertoire ${limit} limit exceeded: ${actual} > ${max} (lower the PGN size or split into multiple repertoires)`,
    );
    this.name = 'RepertoireLimitExceededError';
  }
}

// ─── Tokenizer ─────────────────────────────────────────────────────

type Token =
  | { type: 'move'; san: string }
  | { type: 'open' } // '('
  | { type: 'close' } // ')'
  | { type: 'comment'; text: string } // '{ ... }' или '; ... \n'
  | { type: 'nag'; n: number }; // '$N'

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

function stripHeaders(pgn: string): string {
  // Удаляем [Header "value"] построчно (PGN-стандарт §8).
  return pgn.replace(/^\[[^\]]*\][ \t]*\r?\n?/gm, '');
}

function tokenize(movetext: string): Token[] {
  const tokens: Token[] = [];
  const n = movetext.length;
  let i = 0;
  while (i < n) {
    const ch = movetext[i];
    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    // variation open / close
    if (ch === '(') {
      tokens.push({ type: 'open' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'close' });
      i++;
      continue;
    }
    // block comment '{ ... }'
    if (ch === '{') {
      const end = movetext.indexOf('}', i);
      if (end === -1) {
        throw new RepertoirePgnError(
          `Unclosed block comment '{' at offset ${i}`,
        );
      }
      tokens.push({
        type: 'comment',
        text: movetext.slice(i + 1, end).trim(),
      });
      i = end + 1;
      continue;
    }
    // line comment '; ... \n'
    if (ch === ';') {
      const end = movetext.indexOf('\n', i);
      const slice =
        end === -1 ? movetext.slice(i + 1) : movetext.slice(i + 1, end);
      tokens.push({ type: 'comment', text: slice.trim() });
      i = end === -1 ? n : end + 1;
      continue;
    }
    // NAG '$N'
    if (ch === '$') {
      let j = i + 1;
      while (j < n && movetext[j] >= '0' && movetext[j] <= '9') j++;
      const num = parseInt(movetext.slice(i + 1, j), 10);
      if (!Number.isNaN(num)) tokens.push({ type: 'nag', n: num });
      i = j;
      continue;
    }
    // digit: move number (1., 1...) или результат партии (1-0, 0-1, 1/2-1/2)
    if (ch >= '0' && ch <= '9') {
      // 1) Сначала пробуем «полный токен» до пробела/скобки — нужен для результатов
      //    вроде `1-0`, `1/2-1/2`. Move numbers вида `1.` / `12...` тоже сюда попадут,
      //    но они НЕ начинаются с `digit-` или `digit/`, поэтому различим ниже.
      let j = i;
      while (j < n && !/[\s(){};$]/.test(movetext[j])) j++;
      const tok = movetext.slice(i, j);
      if (RESULT_TOKENS.has(tok)) {
        // окончание партии, скипаем
        i = j;
        continue;
      }
      // move number — тоже скипаем (chess.js move() работает без них)
      i = j;
      continue;
    }
    // result '*'
    if (ch === '*') {
      i++;
      continue;
    }
    // SAN-ход: всё до разделителя
    let j = i;
    while (j < n && !/[\s(){};$]/.test(movetext[j])) j++;
    const raw = movetext.slice(i, j);
    if (raw) tokens.push({ type: 'move', san: raw });
    i = j;
  }
  return tokens;
}

// ─── Tree builder ──────────────────────────────────────────────────

/**
 * Удаляет аннотации `!`, `?` (и комбинации `?!`, `!?`, `!!`, `??`) из
 * хвоста SAN. chess.js 1.x в `move()` НЕ всегда их съедает — лучше
 * страховаться. Знаки шаха `+` и мата `#` оставляем — они валидный SAN.
 */
function stripSanAnnotations(san: string): string {
  return san.replace(/[!?]+$/, '');
}

interface BuildContext {
  root: RepertoireTree;
  /** Reusable chess instance — load(fen) дёшево, new Chess() дороже. */
  chess: Chess;
}

function ensureNode(ctx: BuildContext, fen: string): RepertoireNode {
  let node = ctx.root.nodes[fen];
  if (!node) {
    node = { fen, edges: [] };
    ctx.root.nodes[fen] = node;
    ctx.root.meta.nodeCount++;
    if (ctx.root.meta.nodeCount > OPENING_REPERTOIRE_LIMITS.maxNodes) {
      throw new RepertoireLimitExceededError(
        'nodes',
        ctx.root.meta.nodeCount,
        OPENING_REPERTOIRE_LIMITS.maxNodes,
      );
    }
  }
  return node;
}

/**
 * Обходит токены, начиная с `startIdx`. Возвращает индекс «после
 * закрывающей скобки» (для рекурсивного вызова из `'open'`) или
 * `tokens.length` если scope закончился по концу потока.
 *
 * `startDepth` — глубина (полуходы от корня) ПЕРЕД первым ходом этого
 * scope'а. Для основной линии = 0; для variation = depth родительской
 * развилки − 1 (т. к. первый ход variation лендится на ту же глубину,
 * что и main-ход в развилке).
 */
function parseTokens(
  tokens: Token[],
  startIdx: number,
  ctx: BuildContext,
  startDepth: number,
): number {
  let i = startIdx;
  let currentDepth = startDepth;
  // FEN ПЕРЕД последним сыгранным в этом scope ходом — нужен чтобы
  // знать «откуда» начинается variation: '(...)' открывается ОТ позиции
  // перед предыдущим main-ходом.
  let lastMoveFen: string | null = null;
  // Ссылка на последний созданный/найденный edge в этом scope —
  // именно к нему PGN-стандарт привязывает следующие `{comment}` / `$N`.
  let lastEdge: RepertoireEdge | null = null;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.type === 'close') {
      return i + 1;
    }

    if (tok.type === 'open') {
      if (lastMoveFen === null) {
        // variation без предшествующего main-хода (например, prefix-вариант)
        // — допустим: variation работает от текущей позиции chess'а.
        const here = ctx.chess.fen();
        i = parseTokens(tokens, i + 1, ctx, currentDepth);
        ctx.chess.load(here, { skipValidation: true });
        continue;
      }
      // Стандартный случай: variation от позиции перед последним main-ходом.
      const savedFen = ctx.chess.fen();
      ctx.chess.load(lastMoveFen, { skipValidation: true });
      // Первый ход variation лендится на глубину currentDepth (= уровень main-хода).
      i = parseTokens(tokens, i + 1, ctx, currentDepth - 1);
      ctx.chess.load(savedFen, { skipValidation: true });
      continue;
    }

    if (tok.type === 'comment') {
      // PGN-стандарт: comment относится к ПРЕДЫДУЩЕМУ ходу (`1. e4 {note}`).
      // Если предыдущего хода ещё нет (preamble на старте партии) — игнорируем.
      if (lastEdge && lastEdge.comment === undefined && tok.text) {
        lastEdge.comment = tok.text;
      }
      i++;
      continue;
    }

    if (tok.type === 'nag') {
      if (lastEdge) {
        const arr = lastEdge.nag ?? [];
        arr.push(tok.n);
        lastEdge.nag = arr;
      }
      i++;
      continue;
    }

    // tok.type === 'move'
    const fromFen = ctx.chess.fen();
    const sanClean = stripSanAnnotations(tok.san);
    let move: ReturnType<Chess['move']>;
    try {
      move = ctx.chess.move(sanClean);
    } catch (err) {
      throw new RepertoirePgnError(
        `Illegal move "${tok.san}" at position ${fromFen}: ${(err as Error).message}`,
      );
    }
    if (!move) {
      throw new RepertoirePgnError(
        `Move "${tok.san}" rejected at position ${fromFen}`,
      );
    }
    const childFen = ctx.chess.fen();
    currentDepth++;
    if (currentDepth > OPENING_REPERTOIRE_LIMITS.maxDepthHalfMoves) {
      throw new RepertoireLimitExceededError(
        'depth',
        currentDepth,
        OPENING_REPERTOIRE_LIMITS.maxDepthHalfMoves,
      );
    }
    if (currentDepth > ctx.root.meta.maxDepth) {
      ctx.root.meta.maxDepth = currentDepth;
    }

    const parentNode = ensureNode(ctx, fromFen);
    ensureNode(ctx, childFen);

    const uci =
      move.from + move.to + (move.promotion ? move.promotion : '');

    // Транспозиция-по-edge: если из этой позиции уже записан этот ход,
    // ничего не добавляем (merge'им аннотации: первый встретившийся
    // выигрывает — это детерминизм, проще для UX).
    let edge = parentNode.edges.find((e) => e.moveUci === uci);
    if (!edge) {
      edge = {
        moveUci: uci,
        moveSan: move.san,
        childFen,
      };
      parentNode.edges.push(edge);
      ctx.root.meta.edgeCount++;
      if (ctx.root.meta.edgeCount > OPENING_REPERTOIRE_LIMITS.maxEdges) {
        throw new RepertoireLimitExceededError(
          'edges',
          ctx.root.meta.edgeCount,
          OPENING_REPERTOIRE_LIMITS.maxEdges,
        );
      }
    }

    lastMoveFen = fromFen;
    lastEdge = edge;
    i++;
  }
  return i;
}

@Injectable()
export class RepertoireBuilderService {
  /**
   * Главный entry-point: PGN-строка → `RepertoireTree`.
   *
   * Throws:
   *   - `RepertoirePgnError`           — синтаксис / illegal move
   *   - `RepertoireLimitExceededError` — превышены ADR-лимиты
   */
  buildTree(pgn: string): RepertoireTree {
    if (typeof pgn !== 'string' || pgn.trim().length === 0) {
      throw new RepertoirePgnError('PGN is empty');
    }

    // 1. Лимит размера — БАЙТ, не символов (UTF-8 заголовки игроков).
    const byteLen = Buffer.byteLength(pgn, 'utf8');
    if (byteLen > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
      throw new RepertoireLimitExceededError(
        'pgn-size',
        byteLen,
        OPENING_REPERTOIRE_LIMITS.maxPgnBytes,
      );
    }

    // 2. Strip headers + tokenize.
    const movetext = stripHeaders(pgn);
    const tokens = tokenize(movetext);

    // 3. Init tree (root = стартовая позиция).
    const chess = new Chess();
    const rootFen = chess.fen();
    const root: RepertoireTree = {
      rootFen,
      nodes: {
        [rootFen]: { fen: rootFen, edges: [] },
      },
      meta: { nodeCount: 1, edgeCount: 0, maxDepth: 0 },
    };

    // 4. Recursive walk.
    const ctx: BuildContext = { root, chess };
    parseTokens(tokens, 0, ctx, 0);

    // 5. Sanity: хоть один ход должен быть сыгран (иначе это empty PGN).
    if (root.meta.edgeCount === 0) {
      throw new RepertoirePgnError(
        'PGN contains no playable moves (only headers / comments?)',
      );
    }

    return root;
  }
}

// Re-export типы для импортирующих модулей.
export type { RepertoireTree, RepertoireNode, RepertoireEdge };
