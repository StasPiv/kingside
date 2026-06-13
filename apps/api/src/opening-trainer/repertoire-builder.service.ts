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

// KS-3335: 'depth' оставлен в union как deprecated значение
// (на случай если где-то старый код матчится на это значение).
// Реально новый код его не использует — проверка глубины убрана.
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
const RESULT_TOKENS_RE = /(1-0|0-1|1\/2-1\/2|\*)/g;

/**
 * KS-4105. Null-move токены (пропуск хода, смена стороны без хода):
 *   - `--`   — стандартная PGN-нотация null-move;
 *   - `Z0`   — ChessBase-нотация того же;
 *   - `0000` / `@@@@` — UCI-формы (на всякий случай).
 * chess.js их не поддерживает и бросает Invalid move. В репертуаре
 * null-move не тренируется, поэтому ветку с ним пропускаем (см.
 * `parseTokens`), НЕ обрывая импорт всего PGN.
 */
const NULL_MOVE_RE = /^(?:--|Z0|0000|@@@@)$/i;
function isNullMoveSan(san: string): boolean {
  return NULL_MOVE_RE.test(san.trim());
}

function stripHeaders(pgn: string): string {
  // Удаляем [Header "value"] построчно (PGN-стандарт §8).
  return pgn.replace(/^\[[^\]]*\][ \t]*\r?\n?/gm, '');
}

/**
 * KS-3325 / ADR-078. Разбивает многопартийный PGN на массив отдельных
 * PGN-строк (по одной партии в каждой).
 *
 * Разделитель — токен результата (`1-0`, `0-1`, `1/2-1/2`, `*`). Всё
 * что между двумя результатами — одна партия (включая её headers).
 * Headers партии остаются с ней (для будущих fallback'ов на `[Event]`-
 * имя источника).
 *
 * Edge cases:
 *   - PGN без результата (только movetext) → возвращает `[pgn]`.
 *   - Пустые «партии» (только whitespace) отфильтровываются.
 *   - `*` и комбинации с whitespace → корректно отделяются.
 *
 * Существующий tokenize() уже skip'ает result-токены, но multi-game PGN
 * ранее ломался: chess-instance не сбрасывался между играми, и второй
 * `1.e4` пытался сыграться из позиции после `1-0` предыдущей партии
 * → `Illegal move`. Решение — split + fresh chess-instance per game.
 */
export function splitPgnIntoGames(pgn: string): string[] {
  if (typeof pgn !== 'string' || pgn.trim().length === 0) return [];
  // KS-3325 fix (KS-3325 follow-up): сначала убираем PGN-headers
  // ([Event "..."], [Result "1-0"], …) — иначе result-token внутри
  // `[Result "1-0"]` regex'ом ниже считается разделителем и режет
  // PGN неправильно (фактическое падение builder'а в проде: вместо
  // movetext попадал кусок `[Event ...] [Site ...] [Result "1-0"` без
  // ходов → `Illegal move "[Result"`). После strip'а headers'ы исчезают,
  // и result-токен `1-0` встречается только в реальном завершении партии.
  pgn = stripHeaders(pgn);
  if (pgn.trim().length === 0) return [];
  const games: string[] = [];
  let lastIdx = 0;
  RESULT_TOKENS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RESULT_TOKENS_RE.exec(pgn)) !== null) {
    // Проверка что result-token не внутри `{...}` или `;...` коммента
    // и не внутри movetext-цифр (вроде `21-0` — не результат). Простой
    // эвристический skip: смотрим предшествующий символ — если digit,
    // это вероятно move-number или похожее.
    const before = match.index > 0 ? pgn[match.index - 1] : ' ';
    if (/[0-9]/.test(before) && match[0] !== '1-0' && match[0] !== '0-1' && match[0] !== '1/2-1/2') {
      continue;
    }
    // Внутри комментариев? Простая проверка: ищем непарную `{` слева
    // в текущем фрагменте; если есть — внутри комментария.
    const fragment = pgn.slice(lastIdx, match.index);
    const openBraces = (fragment.match(/\{/g) ?? []).length;
    const closeBraces = (fragment.match(/\}/g) ?? []).length;
    if (openBraces > closeBraces) {
      continue; // result-token внутри `{...}`, пропускаем
    }
    const endIdx = match.index + match[0].length;
    const game = pgn.slice(lastIdx, endIdx).trim();
    if (game.length > 0) games.push(game);
    lastIdx = endIdx;
  }
  // Хвост без result-token'а — тоже валидная партия (PGN-стандарт
  // допускает отсутствие результата).
  const tail = pgn.slice(lastIdx).trim();
  if (tail.length > 0) games.push(tail);
  // Если разделители вообще не нашлись — возвращаем оригинал как одну партию.
  if (games.length === 0 && pgn.trim().length > 0) games.push(pgn.trim());
  return games;
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
  /**
   * KS-3325 / ADR-078. ID источника, для которого сейчас идёт обход.
   * Используется в parseTokens для union'а `edge.sourceIds`. Если null
   * (обратная совместимость со старым `buildTree(string)`) — поле
   * `sourceIds` не проставляется.
   */
  sourceId: string | null;
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
/**
 * KS-4105. Пропускает остаток ТЕКУЩЕГО scope'а, начиная с `i`: считает
 * вложенность `(`/`)` и возвращает индекс ПОСЛЕ закрывающей скобки
 * этого scope'а (или `tokens.length`, если scope — основная линия и
 * закрывающей скобки нет). Используется, когда в ветке встретился
 * null-move: дальше по этой линии очередь ходов сдвинута (следующий ход
 * был бы за неверную сторону), поэтому остаток ветки отбрасываем, но
 * родительский scope и соседние варианты продолжаются.
 */
function skipToScopeEnd(tokens: Token[], i: number): number {
  let depth = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'open') depth++;
    else if (t.type === 'close') {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return tokens.length;
}

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
      // KS-3325: keep-first (если comment уже есть от предыдущего source — не перезаписываем).
      if (lastEdge && lastEdge.comment === undefined && tok.text) {
        lastEdge.comment = tok.text;
      }
      i++;
      continue;
    }

    if (tok.type === 'nag') {
      if (lastEdge) {
        // KS-3325: union NAGs от всех источников. Раньше было first-wins
        // (просто push) — но при multi-source один и тот же NAG может
        // прийти из нескольких источников; дедуп через Set.
        const arr = lastEdge.nag ?? [];
        if (!arr.includes(tok.n)) arr.push(tok.n);
        lastEdge.nag = arr;
      }
      i++;
      continue;
    }

    // tok.type === 'move'
    const fromFen = ctx.chess.fen();

    // KS-4105. Null-move (`Z0` / `--`): chess.js его не парсит и бросает
    // Invalid move, обрывая весь импорт. В репертуаре null-move не
    // тренируется. Пропускаем остаток текущей ветки (после null-move
    // очередь ходов сдвинута — играть их за неверную сторону нельзя),
    // фиксируем предупреждение и продолжаем с родительского scope'а /
    // соседних вариантов. Уже разобранные ходы этой ветки сохраняются.
    if (isNullMoveSan(tok.san)) {
      const meta = ctx.root.meta;
      (meta.warnings ??= []).push(
        `Null-move "${tok.san}" at ${fromFen} — ветка пропущена (null-move не тренируется)`,
      );
      return skipToScopeEnd(tokens, i + 1);
    }

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
    // KS-3335: depth-лимит снят. maxDepth поле tree.meta остаётся
    // (используется UI), но без throw на превышении.
    if (currentDepth > ctx.root.meta.maxDepth) {
      ctx.root.meta.maxDepth = currentDepth;
    }

    const parentNode = ensureNode(ctx, fromFen);
    ensureNode(ctx, childFen);

    const uci =
      move.from + move.to + (move.promotion ? move.promotion : '');

    // Транспозиция-по-edge: если из этой позиции уже записан этот ход,
    // ничего не добавляем (merge'им аннотации: первый встретившийся
    // выигрывает для comment — детерминизм, проще для UX; NAG'и
    // union'им; sourceIds union'им через Set).
    let edge = parentNode.edges.find((e) => e.moveUci === uci);
    if (!edge) {
      edge = {
        moveUci: uci,
        moveSan: move.san,
        childFen,
      };
      if (ctx.sourceId !== null) {
        edge.sourceIds = [ctx.sourceId];
      }
      parentNode.edges.push(edge);
      ctx.root.meta.edgeCount++;
      if (ctx.root.meta.edgeCount > OPENING_REPERTOIRE_LIMITS.maxEdges) {
        throw new RepertoireLimitExceededError(
          'edges',
          ctx.root.meta.edgeCount,
          OPENING_REPERTOIRE_LIMITS.maxEdges,
        );
      }
    } else if (ctx.sourceId !== null) {
      // KS-3325: union sourceIds. Транспозиция от другого источника —
      // добавляем его ID если ещё нет.
      const sids = edge.sourceIds ?? [];
      if (!sids.includes(ctx.sourceId)) {
        sids.push(ctx.sourceId);
        edge.sourceIds = sids;
      }
    }

    lastMoveFen = fromFen;
    lastEdge = edge;
    i++;
  }
  return i;
}

/**
 * KS-3325 / ADR-078. Один источник для multi-source builder.
 */
export interface RepertoireSourceInput {
  /** UUID источника (`OpeningRepertoireSource.id`). */
  sourceId: string;
  pgn: string;
}

@Injectable()
export class RepertoireBuilderService {
  /**
   * Backward-compat entry-point: один PGN → `RepertoireTree` (без
   * `sourceIds` на edge'ах — поле просто не проставляется). Сохранён
   * для существующих тестов и кода, который ещё не переведён на
   * multi-source (KS-3326 будет переключать вызовы).
   *
   * Внутри проходит через `splitPgnIntoGames` + per-game fresh chess
   * — фиксит баг multi-game PGN (без сброса chess-instance после `1-0`).
   */
  buildTree(pgn: string): RepertoireTree {
    return this.buildTreeInternal(
      pgn,
      null /* sourceId — backward-compat, sourceIds не проставляются */,
      this.createEmptyTree(),
    );
  }

  /**
   * KS-3325 / ADR-078 §2.3. Multi-source entry-point: массив источников
   * → единое `RepertoireTree` с union edge'ов по `sourceIds`.
   *
   * Семантика:
   *   - Edges с одинаковым `(fromFen, moveUci)` из разных источников —
   *     один edge с `sourceIds: [id1, id2, ...]`.
   *   - NAGs — union (раньше first-wins).
   *   - Comments — keep-first (первый встретившийся выигрывает).
   *
   * Каждый source независимо проходит через `splitPgnIntoGames` (для
   * multi-game PGN). Sanity-проверка `edgeCount > 0` — для всего дерева
   * (агрегация всех sources), не per-source.
   *
   * Throws:
   *   - `RepertoirePgnError`           — синтаксис / illegal move
   *   - `RepertoireLimitExceededError` — лимиты ADR
   */
  buildTreeFromSources(sources: RepertoireSourceInput[]): RepertoireTree {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new RepertoirePgnError('At least one source is required');
    }
    const tree = this.createEmptyTree();
    for (const src of sources) {
      this.buildTreeInternal(src.pgn, src.sourceId, tree);
    }
    if (tree.meta.edgeCount === 0) {
      throw new RepertoirePgnError(
        'PGN contains no playable moves (only headers / comments?)',
      );
    }
    return tree;
  }

  private createEmptyTree(): RepertoireTree {
    const rootFen = new Chess().fen();
    return {
      rootFen,
      nodes: { [rootFen]: { fen: rootFen, edges: [] } },
      meta: { nodeCount: 1, edgeCount: 0, maxDepth: 0 },
    };
  }

  /**
   * Внутренний worker: обрабатывает один PGN (может быть многопартийным)
   * и аккумулирует результат в переданный tree. Если `sourceId` задан —
   * edges получают/обновляют `sourceIds`. Возвращает тот же tree
   * (мутируется).
   *
   * Если PGN пустой/безходовой — НЕ бросает (это caller'у решать;
   * `buildTree` бросает на edgeCount=0; `buildTreeFromSources` проверяет
   * после обхода всех sources).
   */
  private buildTreeInternal(
    pgn: string,
    sourceId: string | null,
    tree: RepertoireTree,
  ): RepertoireTree {
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

    // 2. KS-3325: split на отдельные партии. Каждую — fresh chess.
    const games = splitPgnIntoGames(pgn);
    if (games.length === 0) {
      throw new RepertoirePgnError(
        'PGN contains no playable moves (only headers / comments?)',
      );
    }

    for (const game of games) {
      const movetext = stripHeaders(game);
      const tokens = tokenize(movetext);
      if (tokens.length === 0) continue; // empty game между result-токенами

      const chess = new Chess();
      const ctx: BuildContext = { root: tree, chess, sourceId };
      parseTokens(tokens, 0, ctx, 0);
    }

    // backward-compat: `buildTree(pgn)` валидирует edgeCount > 0 здесь
    // (один source — должен дать хоть что-то). Multi-source агрегирует
    // и проверяет в `buildTreeFromSources` после прохода всех sources.
    if (sourceId === null && tree.meta.edgeCount === 0) {
      throw new RepertoirePgnError(
        'PGN contains no playable moves (only headers / comments?)',
      );
    }

    return tree;
  }
}

// Re-export типы для импортирующих модулей.
export type { RepertoireTree, RepertoireNode, RepertoireEdge };
