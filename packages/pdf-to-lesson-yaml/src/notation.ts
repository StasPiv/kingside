/**
 * KS-2046 — парсер long-algebraic нотации Калиниченко 2016 → SAN
 * через прокатку chess.js.
 *
 * Книга использует:
 *   - inline-глифы фигур (Chess-Merida PUA U+F0A2..U+F0A6) — раскрыты
 *     до ASCII-букв `K/Q/N/B/R` уже в Python-extractor'е (см.
 *     `src/python/extract_pdf.py#INLINE_PIECE_GLYPHS`);
 *   - long-algebraic «Nf3-d4», «Bf1xa6» (тире «-» — простой ход,
 *     «x» / «:» / «×» — взятие);
 *   - часть file-букв набирается **кириллицей**: `а e с в` (визуально
 *     не отличаются от Latin, но codepoint другой) — нормализуем
 *     до Latin перед прокаткой;
 *   - рокировка: `O-O`, `O-O-O`, `0-0`, `0-0-0`;
 *   - check/mate: `+`, `#`, плюс кириллический «х» («шах») и просто `x`
 *     на конце моряка-мата (не путать с separator-`x` для взятия —
 *     различается позиционно).
 *
 * Парсер делает три вещи:
 *   1. `tokenize` — разбивает строку на список токенов «move-number /
 *      move-candidate / prose-chunk» с сохранением порядка.
 *   2. `tryConvertGame` — пытается прокатить токены через chess.js,
 *      получает SAN-эквивалент. Если хоть один move-candidate не
 *      легализуется на текущей позиции — игра считается «не партией»
 *      и попадает обратно в text-шаг. PGN ходов с дисамбигуацией
 *      `Rdxh8` chess.js строит сам.
 *   3. `buildPgnFromTokens` — собирает финальный PGN-текст с inline
 *      `{...}` комментариями к нужным ходам (на основании prose-токенов
 *      между ходами).
 */

import { Chess } from 'chess.js';

// ─── константы ────────────────────────────────────────────────────────

/**
 * Кириллица → Latin для file-букв и редких пометок мата. `х`(U+0445)
 * = «шах»/мат-маркер, при разборе считаем эквивалентом `x`.
 */
const CYR_TO_LATIN: Record<string, string> = {
  // Файлы доски — точные совпадения по визуалу:
  'а': 'a', // а → a
  'в': 'b', // в → b
  'с': 'c', // с → c
  'е': 'e', // е → e
  'х': 'x', // х (мат/взятие) → x
  // Заглавные:
  'А': 'a',
  'В': 'b',
  'С': 'c',
  'Е': 'e',
  'Х': 'x',
};

export function normalizeChessChars(s: string): string {
  let out = '';
  for (const c of s) {
    out += CYR_TO_LATIN[c] ?? c;
  }
  return out;
}

// ─── токенизация ──────────────────────────────────────────────────────

/** Move-number, например `1.`, `12.`, `1...`. */
const MOVE_NUMBER_RE = /^(\d{1,3})\.{1,3}/;

/**
 * Long-algebraic move: piece-letter? + from-square + separator + to-square
 * + опц. promotion + опц. check/mate.
 *
 * Допускаем: piece — KQRBN, separator — один из `-x:×х`, suffix — `+`,
 * `#` или просто закрывающий пробел.
 */
const LONG_ALG_MOVE_RE = /^([KQRBN])?([a-h])([1-8])([-x:×х])([a-h])([1-8])(?:=([QRBN]))?([+#])?(?=[\s,.;:!?)\]]|$)/;

/** Короткая SAN-форма (без `from-square`): уже SAN. */
const SHORT_SAN_RE = /^([KQRBN])?([a-h]?)(x)?([a-h])([1-8])(?:=([QRBN]))?([+#])?(?=[\s,.;:!?)\]]|$)/;

/** Рокировка. */
const CASTLE_RE = /^(O-O-O|O-O|0-0-0|0-0)(?=[\s,.;:!?)\]]|$)/;

export interface MoveNumberToken {
  kind: 'moveNumber';
  number: number;
  isBlackContinuation: boolean; // true для «12...»
  raw: string;
  start: number;
  end: number;
}

export interface MoveToken {
  kind: 'move';
  /** Оригинальный текст из источника (не нормализованный). */
  raw: string;
  /** Кандидат-SAN после Cyr→Latin нормализации. */
  candidate: string;
  start: number;
  end: number;
}

export interface ProseToken {
  kind: 'prose';
  text: string;
  start: number;
  end: number;
}

export type Token = MoveNumberToken | MoveToken | ProseToken;

/**
 * Tokenize prose-строку на список (Move-number | Move | Prose).
 *
 * Используется двойная строка:
 *   `rawInput` — оригинал (для prose-токенов, чтобы кириллица в обычной
 *   прозе не подменилась на Latin);
 *   `norm` — Cyr→Latin (для regex-матчинга, потому что `е` (U+0435)
 *   в файле-букве не входит в `[a-h]`).
 *
 * `normalizeChessChars` свопит char-в-char, поэтому позиции в `raw` и
 * `norm` совпадают.
 */
export function tokenize(rawInput: string): Token[] {
  const norm = normalizeChessChars(rawInput);
  const tokens: Token[] = [];
  let proseStart = 0;
  let i = 0;

  const flushProse = (end: number): void => {
    if (end > proseStart) {
      const txt = rawInput.slice(proseStart, end);
      if (txt.length > 0) {
        tokens.push({ kind: 'prose', text: txt, start: proseStart, end });
      }
    }
  };

  while (i < norm.length) {
    const rest = norm.slice(i);
    const prev = i === 0 ? ' ' : norm[i - 1];
    const atBoundary = /[\s.,;:!?(\[]/.test(prev) || i === 0;

    if (atBoundary) {
      const mNum = MOVE_NUMBER_RE.exec(rest);
      if (mNum) {
        flushProse(i);
        const raw = rawInput.slice(i, i + mNum[0].length);
        tokens.push({
          kind: 'moveNumber',
          number: Number(mNum[1]),
          isBlackContinuation: mNum[0].endsWith('...'),
          raw,
          start: i,
          end: i + mNum[0].length,
        });
        i += mNum[0].length;
        proseStart = i;
        continue;
      }

      const mCastle = CASTLE_RE.exec(rest);
      if (mCastle) {
        flushProse(i);
        const len = mCastle[1].length;
        const raw = rawInput.slice(i, i + len);
        tokens.push({
          kind: 'move',
          raw,
          candidate: mCastle[1].replace(/0/g, 'O'),
          start: i,
          end: i + len,
        });
        i += len;
        proseStart = i;
        continue;
      }

      const mLong = LONG_ALG_MOVE_RE.exec(rest);
      if (mLong) {
        flushProse(i);
        const len = mLong[0].length;
        const raw = rawInput.slice(i, i + len);
        // candidate — нормализованный фрагмент, raw — оригинал.
        tokens.push({
          kind: 'move',
          raw,
          candidate: norm.slice(i, i + len),
          start: i,
          end: i + len,
        });
        i += len;
        proseStart = i;
        continue;
      }

      const mShort = SHORT_SAN_RE.exec(rest);
      if (mShort && /^[KQRBN]/.test(mShort[0])) {
        flushProse(i);
        const len = mShort[0].length;
        const raw = rawInput.slice(i, i + len);
        tokens.push({
          kind: 'move',
          raw,
          candidate: norm.slice(i, i + len),
          start: i,
          end: i + len,
        });
        i += len;
        proseStart = i;
        continue;
      }
    }
    i++;
  }
  flushProse(norm.length);
  return tokens;
}

// ─── конвертация long-algebraic → SAN ────────────────────────────────

/**
 * Применить long-algebraic move к chess.js-доске, получить SAN.
 * Возвращает null, если ход не легализуется.
 */
function applyLongAlgebraic(chess: Chess, candidate: string): string | null {
  // Castling — chess.js принимает «O-O» / «O-O-O» как SAN.
  if (candidate === 'O-O' || candidate === 'O-O-O') {
    try {
      const m = chess.move(candidate);
      return m?.san ?? null;
    } catch {
      return null;
    }
  }

  const longMatch = LONG_ALG_MOVE_RE.exec(candidate);
  if (longMatch) {
    const [, , fromFile, fromRank, , toFile, toRank, promo] = longMatch;
    const from = `${fromFile}${fromRank}`;
    const to = `${toFile}${toRank}`;
    try {
      const m = chess.move({
        from,
        to,
        ...(promo ? { promotion: promo.toLowerCase() } : {}),
      });
      return m?.san ?? null;
    } catch {
      return null;
    }
  }
  // Уже SAN — пытаемся принять как есть.
  try {
    const m = chess.move(candidate);
    return m?.san ?? null;
  } catch {
    return null;
  }
}

// ─── PGN-сборка ───────────────────────────────────────────────────────

export interface ConvertedGame {
  /** Список SAN-ходов с inline-комментариями. */
  moves: { san: string; comment: string | null }[];
  /** Текст до 1-го хода (для pre-game комментария). */
  preComment: string | null;
  /** Текст после последнего хода (для post-game комментария). */
  postComment: string | null;
  /** FEN, от которого играли (если задан — будет в `[FEN]` заголовке). */
  startFen: string | null;
}

export interface ConvertOptions {
  /** Стартовая позиция (FEN). По умолчанию — стандартная. */
  startFen?: string;
  /** Минимум ходов, чтобы считать серию игрой. По умолчанию 4. */
  minMoves?: number;
}

export interface ConvertResult {
  ok: boolean;
  /** Если ok=false — причина (для логов). */
  reason?: string;
  /** Если ok=true — конвертированная партия. */
  game?: ConvertedGame;
  /** Сколько токенов первой не партии скушалось до отказа (для отрезания head'а). */
  consumedTokens?: number;
}

/**
 * Открытая партия — состояние, которое накапливается по нескольким
 * блокам PDF (heading-как-нотация, prose-как-комментарий) до тех пор,
 * пока структура не выйдет из режима игры (появилась новая диаграмма,
 * новый заголовок не-нотации и т. п.).
 */
export interface OpenGame {
  chess: Chess;
  moves: { san: string; comment: string | null }[];
  preComment: string | null;
  postComment: string | null;
  startFen: string | null;
  /** Сколько ходов пытались добавить — для отладки/метрик. */
  totalAttempts: number;
}

export function newOpenGame(startFen?: string): OpenGame | null {
  let chess: Chess;
  try {
    chess = startFen ? new Chess(startFen) : new Chess();
  } catch {
    return null;
  }
  return {
    chess,
    moves: [],
    preComment: null,
    postComment: null,
    startFen: startFen ?? null,
    totalAttempts: 0,
  };
}

export interface ExtendResult {
  /** true — все ходы из tokens легализовались, блок принят как часть игры. */
  ok: boolean;
  /** Сколько MoveToken'ов было в input'е. */
  moveCount: number;
  /** Сколько ходов добавили в openGame (только при ok=true). */
  acceptedCount: number;
  reason?: string;
}

/**
 * Попытаться расширить открытую партию `og` ходами из `tokens`.
 *
 * Если все MoveToken'ы легализуются — `ok: true`, ходы добавлены, prose
 * между ними стало inline-комментариями. Если хоть один не легализуется —
 * `ok: false`, состояние `og` НЕ изменено.
 */
export function extendOpenGame(og: OpenGame, tokens: Token[]): ExtendResult {
  // Pre-flight: прокатываем на копии. Если проходит — применяем.
  const copy = new Chess(og.chess.fen());
  const newMoves: { san: string; comment: string | null }[] = [];
  let pendingComment: string[] = [];
  let firstMoveSeen = og.moves.length > 0;
  let preChunks: string[] = [];
  let moveCount = 0;
  let acceptedCount = 0;

  for (const tok of tokens) {
    if (tok.kind === 'moveNumber') continue;
    if (tok.kind === 'prose') {
      const t = tok.text.trim();
      if (!t) continue;
      if (!firstMoveSeen) {
        preChunks.push(t);
      } else {
        pendingComment.push(t);
      }
      continue;
    }
    moveCount++;
    const san = applyLongAlgebraic(copy, tok.candidate);
    if (san === null) {
      return {
        ok: false,
        moveCount,
        acceptedCount,
        reason: `illegal move "${tok.candidate}" at ${copy.fen()}`,
      };
    }
    if (firstMoveSeen) {
      const lastMoveLocalIdx = newMoves.length - 1;
      if (pendingComment.length > 0) {
        if (lastMoveLocalIdx >= 0) {
          const prev = newMoves[lastMoveLocalIdx];
          const merged = pendingComment.join(' ').replace(/\s+/g, ' ').trim();
          prev.comment = prev.comment ? `${prev.comment} ${merged}` : merged;
        } else if (og.moves.length > 0) {
          // Первая prose-вставка, относится к последнему ходу из уже
          // принятой части openGame.
          const prev = og.moves[og.moves.length - 1];
          const merged = pendingComment.join(' ').replace(/\s+/g, ' ').trim();
          prev.comment = prev.comment ? `${prev.comment} ${merged}` : merged;
        }
      }
    }
    newMoves.push({ san, comment: null });
    pendingComment = [];
    firstMoveSeen = true;
    acceptedCount++;
  }

  // Применяем результат к настоящему openGame.
  // Pre-comment добавляется к og.preComment (если игра до этого пуста).
  if (preChunks.length > 0) {
    const merged = preChunks.join(' ').replace(/\s+/g, ' ').trim();
    if (og.moves.length === 0 && newMoves.length === 0) {
      og.preComment = og.preComment ? `${og.preComment} ${merged}` : merged;
    } else if (og.moves.length === 0 && newMoves.length > 0) {
      og.preComment = og.preComment ? `${og.preComment} ${merged}` : merged;
    }
  }
  // Применяем ходы к настоящей доске.
  for (const tok of tokens) {
    if (tok.kind !== 'move') continue;
    applyLongAlgebraic(og.chess, tok.candidate);
  }
  og.moves.push(...newMoves);
  og.totalAttempts += moveCount;

  // Сохранить хвостовой pendingComment как post-comment-кандидат
  // (закроется позже, при closeOpenGame).
  if (pendingComment.length > 0) {
    const merged = pendingComment.join(' ').replace(/\s+/g, ' ').trim();
    og.postComment = og.postComment ? `${og.postComment} ${merged}` : merged;
  }

  return { ok: true, moveCount, acceptedCount };
}

/**
 * Добавить чисто-prose-блок к открытой партии: text становится
 * комментарием к последнему ходу (или post-comment'ом, если ходов нет).
 */
export function attachProseToOpenGame(og: OpenGame, prose: string): void {
  const t = prose.trim();
  if (!t) return;
  if (og.moves.length === 0) {
    og.preComment = og.preComment ? `${og.preComment} ${t}` : t;
  } else {
    const last = og.moves[og.moves.length - 1];
    last.comment = last.comment ? `${last.comment} ${t}` : t;
  }
}

/**
 * Прогнать список токенов через chess.js: каждый MoveToken → SAN, prose-токены
 * между ходами становятся inline-комментариями.
 *
 * Если хоть один MoveToken не легализуется — возвращаем `ok: false` с
 * причиной. Вызывающий должен оставить блок как text-шаг.
 */
export function tryConvertGame(
  tokens: Token[],
  options: ConvertOptions = {},
): ConvertResult {
  const minMoves = options.minMoves ?? 4;
  let chess: Chess;
  try {
    chess = options.startFen ? new Chess(options.startFen) : new Chess();
  } catch (e) {
    return {
      ok: false,
      reason: `chess.js rejected startFen "${options.startFen}": ${(e as Error).message}`,
    };
  }

  // Считаем сколько MoveToken'ов в input'е.
  const totalMoves = tokens.filter((t) => t.kind === 'move').length;
  if (totalMoves < minMoves) {
    return { ok: false, reason: `not enough moves (${totalMoves} < ${minMoves})` };
  }

  const moves: ConvertedGame['moves'] = [];
  const preChunks: string[] = [];
  const postChunks: string[] = [];
  let firstMoveSeen = false;
  let pendingComment: string[] = [];

  for (const tok of tokens) {
    if (tok.kind === 'moveNumber') {
      // Игнорируем move-numbers — они появятся в финальной PGN-сериализации
      // автоматически (chess.js#pgn() выставит их сам).
      continue;
    }
    if (tok.kind === 'prose') {
      const trimmed = tok.text.trim();
      if (!trimmed) continue;
      if (!firstMoveSeen) {
        preChunks.push(trimmed);
      } else {
        pendingComment.push(trimmed);
      }
      continue;
    }
    // MoveToken
    const san = applyLongAlgebraic(chess, tok.candidate);
    if (san === null) {
      return {
        ok: false,
        reason: `illegal/unparseable move: "${tok.candidate}" at position ${chess.fen()}`,
      };
    }
    if (firstMoveSeen) {
      // Закрепить накопленный pendingComment за предыдущим ходом.
      const prev = moves[moves.length - 1];
      if (pendingComment.length > 0) {
        const merged = pendingComment.join(' ').replace(/\s+/g, ' ').trim();
        prev.comment = prev.comment ? `${prev.comment} ${merged}` : merged;
      }
    }
    moves.push({ san, comment: null });
    pendingComment = [];
    firstMoveSeen = true;
  }
  // Хвостовой prose после последнего хода → post-comment.
  if (firstMoveSeen && pendingComment.length > 0) {
    const merged = pendingComment.join(' ').replace(/\s+/g, ' ').trim();
    postChunks.push(merged);
  }

  return {
    ok: true,
    game: {
      moves,
      preComment: preChunks.length > 0 ? preChunks.join(' ').trim() : null,
      postComment: postChunks.length > 0 ? postChunks.join(' ').trim() : null,
      startFen: options.startFen ?? null,
    },
  };
}

// ─── PGN-сериализация ─────────────────────────────────────────────────

export interface PgnHeaders {
  Event?: string;
  White?: string;
  Black?: string;
  Result?: string;
  /** Если задан — добавляем `[FEN]` + `[SetUp "1"]`. */
  FEN?: string;
}

/**
 * Из `ConvertedGame` собрать готовый PGN-текст: заголовки + leading comment
 * + ходы с inline-комментариями + post-comment + result-marker.
 */
export function buildPgn(game: ConvertedGame, headers: PgnHeaders = {}): string {
  const headerLines: string[] = [];
  const eventTag = headers.Event ?? 'Capablanca primer (auto-generated)';
  const whiteTag = headers.White ?? '?';
  const blackTag = headers.Black ?? '?';
  const resultTag = headers.Result ?? '*';
  headerLines.push(`[Event "${eventTag.replace(/"/g, "'")}"]`);
  headerLines.push(`[White "${whiteTag}"]`);
  headerLines.push(`[Black "${blackTag}"]`);
  headerLines.push(`[Result "${resultTag}"]`);
  if (game.startFen) {
    headerLines.push(`[FEN "${game.startFen}"]`);
    headerLines.push('[SetUp "1"]');
  }

  // KS-2046: chess.js#loadPgn — strict-режим, не принимает два
  // соседних `{...}` блока. Если у последнего хода УЖЕ есть inline-комментарий,
  // post-comment мерджим в него; иначе post-comment становится комментарием
  // последнего хода.
  const movesWithComments = game.moves.map((m) => ({
    san: m.san,
    comment: cleanComment(m.comment),
  }));
  const postCleaned = cleanComment(game.postComment);
  if (postCleaned && movesWithComments.length > 0) {
    const last = movesWithComments[movesWithComments.length - 1];
    last.comment = last.comment ? `${last.comment} ${postCleaned}` : postCleaned;
  }

  const bodyParts: string[] = [];
  const preCleaned = cleanComment(game.preComment);
  if (preCleaned) {
    bodyParts.push(`{${preCleaned}}`);
  }
  for (let i = 0; i < movesWithComments.length; i++) {
    const moveIdx = i;
    const isWhite = moveIdx % 2 === 0;
    if (isWhite) {
      bodyParts.push(`${Math.floor(moveIdx / 2) + 1}.`);
    }
    bodyParts.push(movesWithComments[i].san);
    if (movesWithComments[i].comment) {
      bodyParts.push(`{${movesWithComments[i].comment}}`);
    }
  }
  bodyParts.push(resultTag);

  return [headerLines.join('\n'), '', bodyParts.join(' ')].join('\n');
}

function escapeComment(s: string): string {
  return s.replace(/[{}]/g, '');
}

/**
 * Очистить «мусорный» комментарий: пунктуация/пробелы/одиночные символы,
 * которые остаются от обрезков предложений ", " и "..." после
 * tokenize. chess.js loadPgn ругается на такие пустые блоки.
 */
function cleanComment(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  // Если осталась только пунктуация (с возможными пробелами) или 1-2 символа.
  if (trimmed.length <= 2) return null;
  if (/^[\s.,;:!?\-…]+$/.test(trimmed)) return null;
  return trimmed;
}
