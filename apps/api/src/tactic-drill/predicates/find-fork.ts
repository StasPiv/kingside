/**
 * KS-2227 / KS-2399 / KS-2400 — `find-fork`.
 *
 * Семантика (после миграции на shape='move'): «найти ход стороны на
 * ходу, который **создаёт новую** вилку — фигуру нашего цвета,
 * атакующую ≥2 ценных фигур противника одновременно». Вилка должна
 * быть **новой** — то есть не существовать в позиции ДО хода. Если
 * вилка уже стояла, любой ход (включая нерелевантный) не считается
 * её созданием. Ответ — `{shape:'move', from, to}`.
 *
 * Прецедент алгоритма snapshot before/after — `find-undefended-attack`
 * (KS-2372/KS-2387). Структура одинакова: сравниваем set «вилкующих
 * наших клеток» до и после каждого легального хода и берём `diff`.
 *
 * Алгоритм:
 *   1. До цикла: соберём `forksBefore: Set<square>` — клетки наших
 *      фигур, у которых |attacks ∩ valuable enemy| ≥ 2.
 *   2. Для каждого легального хода m:
 *      a. apply m.
 *      b. Собрать `forksAfter` тем же способом.
 *      c. Если есть square ∈ forksAfter \ forksBefore — m кандидат.
 *      d. undo.
 *   3. Strict-uniqueness: ровно 1 такой ход, иначе drop.
 *
 * «Ценные» = `n/b/r/q/k` (PIECE_VALUE ≥ 3). Пешки исключены — взятие
 * пешки + minor не считается вилкой по методичке (ADR-035 §2.2.1 g).
 * Король всегда ценен (PIECE_VALUE.k = Infinity).
 *
 * Promotion отбрасываем (v1 без promotion'ов, как и
 * `find-undefended-attack`).
 *
 * Замечание про определение «новой»: после хода m фигура с `from`
 * больше не на доске на этой клетке — она на `to`. Поэтому если
 * вилку делает та же фигура с новой клетки, она автоматически
 * детектируется (новая клетка `to` отсутствует в forksBefore). Если
 * вилку делает другая фигура (discovered fork — вскрылись её атаки
 * после ухода нашей фигуры с линии), её клетка тоже отсутствует в
 * forksBefore (раньше не была вилкой) → детектируется.
 */

import type { AnswerMove } from '@kingside/shared';
import { Chess } from 'chess.js';
import {
  PIECE_VALUE,
  allPieces,
  oppColor,
  tryLoadChess,
  type MoveResult,
} from './types';

const VALUABLE_THRESHOLD = 3;

function collectForks(
  chess: Chess,
  our: 'w' | 'b',
  enemy: 'w' | 'b',
): Set<string> {
  // forker.square → Set<targetSquare>; в результат идут только те
  // forker'ы, у которых targets ≥ 2.
  const forkers = new Map<string, Set<string>>();
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (PIECE_VALUE[p.type] < VALUABLE_THRESHOLD) continue;
    const attackers = chess.attackers(p.square, our);
    for (const fSq of attackers) {
      if (!forkers.has(fSq)) forkers.set(fSq, new Set());
      forkers.get(fSq)!.add(p.square);
    }
  }
  const out = new Set<string>();
  for (const [fSq, targets] of forkers) {
    if (targets.size >= 2) out.add(fSq);
  }
  return out;
}

export function findFork(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  const forksBefore = collectForks(chess, our, enemy);

  const candidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    const forksAfter = collectForks(chess, our, enemy);
    chess.undo();

    let createsNew = false;
    for (const sq of forksAfter) {
      if (!forksBefore.has(sq)) {
        createsNew = true;
        break;
      }
    }
    if (createsNew) {
      candidates.push({ from: m.from, to: m.to });
    }
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 fork-creating move, found ${candidates.length}`,
    };
  }

  const answer: AnswerMove = {
    shape: 'move',
    from: candidates[0].from,
    to: candidates[0].to,
  };
  return { valid: true, answer };
}
