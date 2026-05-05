/**
 * KS-2227 / ADR-035 §2.1 #7 — `count-attackers`.
 *
 * Алгоритм: для подсвеченной клетки `targetSquare` посчитать число
 * фигур цвета `attackerColor`, атакующих эту клетку.
 *
 * Поведение для индексатора:
 *   - сам предикат `countAttackers(fen, square, color)` отдаёт answer
 *     ровно для одной (square, color)-пары.
 *   - дополнительный helper `findCountAttackersCandidates(fen)`
 *     перебирает все 64 клетки × 2 цвета и собирает все валидные
 *     drill-варианты (в одной FEN их может быть много — это норма;
 *     индексатор пишет каждый кандидат как отдельный drill).
 *
 * AnswerNumber.value ∈ [1, 4] (api-contract §3.3 — на UI 4 кнопки).
 * Случаи `attackers(sq).length === 0` или `> 4` отбрасываются.
 */

import type { Color, Square as ChessJsSquare } from 'chess.js';
import type { AnswerNumber } from '@kingside/shared';
import {
  ALL_SQUARES,
  PIECE_VALUE,
  tryLoadChess,
  type NumberResult,
} from './types';

const MIN_VALUE = 1;
const MAX_VALUE = 4;

export function countAttackers(
  fen: string,
  targetSquare: ChessJsSquare,
  attackerColor: Color,
): NumberResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const value = chess.attackers(targetSquare, attackerColor).length;
  if (value < MIN_VALUE || value > MAX_VALUE) {
    return {
      valid: false,
      reason: `attackers count ${value} outside [${MIN_VALUE},${MAX_VALUE}]`,
    };
  }

  const answer: AnswerNumber = { shape: 'number', value };
  return { valid: true, answer };
}

/**
 * Кандидат для `count-attackers`-drill: какая клетка подсвечивается и
 * для какого цвета атакующих считается ответ. Используется индексатором
 * (KS-DRILL-INDEXER) для генерации всех drill'ов из одной FEN.
 */
export interface CountAttackersCandidate {
  targetSquare: ChessJsSquare;
  attackerColor: Color;
  answer: AnswerNumber;
}

export function findCountAttackersCandidates(
  fen: string,
): CountAttackersCandidate[] {
  const chess = tryLoadChess(fen);
  if (!chess) return [];

  const out: CountAttackersCandidate[] = [];
  for (const sq of ALL_SQUARES) {
    for (const color of ['w', 'b'] as const) {
      const value = chess.attackers(sq, color).length;
      if (value >= MIN_VALUE && value <= MAX_VALUE) {
        out.push({
          targetSquare: sq,
          attackerColor: color,
          answer: { shape: 'number', value },
        });
      }
    }
  }
  return out;
}

/**
 * KS-2329. Скоринг + детерминированный tie-break для выбора одного
 * «тактически интересного» кандидата из множества `findCountAttackersCandidates`.
 *
 * До KS-2329 индексер брал `cands[0]` (всегда первый по обходу 64×2 →
 * a1/a2 при наличии хоть одного атакующего). Жалоба пользователя:
 * «подсвечивается всегда a1 либо a2». Здесь скорим кандидатов так,
 * чтобы выбирать атаки на ценные фигуры противника, с предпочтением
 * non-edge клеток и больших батарей.
 *
 * Скоринг (см. KS-2329 ТЗ):
 *   +1000 + 50·pieceValue если на target — фигура противоположного
 *           цвета (атака на чужого; PIECE_VALUE: p=1, n/b=3, r=5, q=9,
 *           k=Inf → 12);
 *   + 200 +  10·pieceValue если на target — фигура того же цвета
 *           (защита своего, менее интересно);
 *   + 100·attackers.length (батарея интереснее одиночной атаки);
 *   −  50 если target — угол (a1/a8/h1/h8);
 *   −  10 если target — край доски (rank 1/8 или file a/h, но не угол).
 *
 * Tie-break — djb2-хеш `fen|sq|color`. Воспроизводится при reindex.
 *
 * Возвращает `null` если массив пуст.
 */
export function pickBestCandidate(
  fen: string,
  candidates: CountAttackersCandidate[],
): CountAttackersCandidate | null {
  if (candidates.length === 0) return null;
  const chess = tryLoadChess(fen);
  if (!chess) return null;

  const corners = new Set<string>(['a1', 'a8', 'h1', 'h8']);

  const scored = candidates.map((c) => {
    const sq = c.targetSquare;
    const piece = chess.get(sq);
    let score = 100 * c.answer.value;

    if (piece) {
      const raw = PIECE_VALUE[piece.type];
      const pieceValue = raw === Infinity ? 12 : raw;
      if (piece.color !== c.attackerColor) {
        // Атака на фигуру противника — самый интересный сценарий.
        score += 1000 + 50 * pieceValue;
      } else {
        // Защита своей фигуры — допустимо, но менее тактически выпукло.
        score += 200 + 10 * pieceValue;
      }
    }

    // Угол доски — традиционно «скучная» подсветка.
    if (corners.has(sq)) {
      score -= 50;
    } else if (
      sq[0] === 'a' || sq[0] === 'h' || sq[1] === '1' || sq[1] === '8'
    ) {
      // Любая edge-клетка кроме углов.
      score -= 10;
    }

    return { c, score, hash: djb2(`${fen}|${sq}|${c.attackerColor}`) };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.hash !== b.hash) return a.hash - b.hash;
    // Финальная стабилизация — по строковому ключу клетки.
    return a.c.targetSquare < b.c.targetSquare ? -1 : 1;
  });

  return scored[0].c;
}

/** djb2 — простой детерминированный 32-bit hash для tie-break'ов. */
function djb2(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Возвращаем unsigned для стабильности сравнения.
  return h >>> 0;
}
