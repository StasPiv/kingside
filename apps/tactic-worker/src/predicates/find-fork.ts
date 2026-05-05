/**
 * KS-2227 / KS-2399 / KS-2400 / KS-2406 / KS-2408 — `find-fork`.
 *
 * Семантика (после миграции на shape='move'): «найти ход стороны на
 * ходу, который **создаёт новую** вилку — фигуру нашего цвета,
 * атакующую ≥2 ценных фигур противника одновременно». Ответ —
 * `{shape:'move', from, to}`.
 *
 * Эволюция определения «новизны»:
 *   - KS-2400: snapshot множества **клеток-форкеров** до/после хода.
 *     Считал creator если появилась клетка форкера, которой не было
 *     раньше. Слабое место — «новая клетка» автоматически появляется
 *     у любой ходящей фигуры, даже если она атакует те же цели, что
 *     и до хода (просто переставилась).
 *   - KS-2408 (этот патч): сравниваем **множества целей** конкретного
 *     форкера до и после хода. Условие новой вилки:
 *       1) форкер на m.to (или другая наша фигура — discovered) после
 *          хода атакует ≥2 ценных фигур противника, и
 *       2) ни одна из этих целей не входит в множество того, что
 *          **тот же форкер** атаковал до хода (intersection = ∅).
 *     Соответствие «тот же форкер» по клетке: для ходящей фигуры
 *     старая клетка = m.from, новая = m.to; для discovered-форкера
 *     (фигура не двигалась) старая = новая = его текущая клетка.
 *     Запрос пользователя: «фигура, продолжающая атаковать ту же
 *     цель + добавляющая вторую» — это не вилка, а доп. атака.
 *
 *   - KS-2406: дополнительный safety-check форкера: если на клетке
 *     форкера после хода есть прямой enemy-attacker → drop. Сохраняем,
 *     применяется ПОСЛЕ нового overlap-фильтра.
 *
 * «Ценные» = `n/b/r/q/k` (PIECE_VALUE ≥ 3). Пешки исключены — взятие
 * пешки + minor не считается вилкой по методичке (ADR-035 §2.2.1 g).
 * Король всегда ценен (PIECE_VALUE.k = Infinity).
 *
 * Promotion отбрасываем (v1 без promotion'ов).
 *
 * Алгоритм (KS-2408):
 *   1. До цикла: `attacksBefore: Map<our-square, Set<enemy-target>>`
 *      — для каждой нашей фигуры собираем множество клеток ценных
 *      enemy-фигур, которые она атакует.
 *   2. Для каждого легального хода m:
 *      a. apply m.
 *      b. Собрать `attacksAfter` тем же способом.
 *      c. Проверить: существует ли наша фигура F с |attacksAfter[F]|≥2
 *         И attacksAfter[F] ∩ attacksBefore[oldSquare(F, m)] = ∅.
 *         oldSquare(F, m) = m.from если F.square == m.to (ходящая
 *         фигура), иначе F.square (discovered-форкер не двигался).
 *      d. Если да — кандидат clean. Дополнительно safety-check на
 *         m.to (KS-2406): если есть enemy-attacker на m.to — кандидат
 *         не safe.
 *      e. undo.
 *   3. Strict-uniqueness: ровно 1 ход с clean+safe, иначе drop.
 *
 * Discovered-форкер: фигура, не делающая ход m, но открывающая
 * новые линии после ухода фигуры с m.from. В моём алгоритме её
 * targetsBefore берётся по её собственной клетке (она не двигалась).
 * Если до хода фигура F через линию атаковала цели T1 (до того, как
 * наша фигура с m.from блокировала линию — а если блокировала, то
 * T1 пусто), а после ухода блокера атаки расширились до T2, то
 * условие clean: T2 ∩ T1 = ∅ И |T2|≥2. Чаще всего T1 = ∅ (фигура
 * была блокирована своей же) — тогда любые ≥2 новых целей дают
 * clean fork. Если же фигура F уже атаковала какие-то цели через
 * другую линию, и после ухода блокера часть осталась той же —
 * получится overlap → drop. Это согласуется с пользовательским
 * запросом «не считать продолжение атаки на ту же цель вилкой».
 *
 * Reason'ы при drop:
 *   - `'invalid_fen'` — FEN не парсится.
 *   - `'unsafe-forker'` — был хотя бы 1 clean fork-creator, но все
 *     отсеялись safety-фильтром (форкер вис). KS-2406.
 *   - `'overlap-with-previous-attacks'` — clean fork-creator'ов нет,
 *     но был хотя бы 1 ход, который дал бы fork с пересекающимися
 *     целями. KS-2408. Учитывается счётчиком `findForkOverlap` в
 *     индексере.
 *   - `'expected exactly 1 …'` — дефолтное общее «не нашли / не
 *     уникально».
 *
 * Приоритет reason'ов: clean есть → smотрим safety → unsafe или ok.
 * Clean нет, overlap есть → overlap. Иначе — общий reason.
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

/**
 * Для каждой нашей фигуры — множество клеток ценных enemy-фигур,
 * которые она атакует прямо сейчас (без учёта пинов; chess.attackers
 * сам учитывает геометрию текущей позиции).
 */
function collectAttacksByPiece(
  chess: Chess,
  our: 'w' | 'b',
  enemy: 'w' | 'b',
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (PIECE_VALUE[p.type] < VALUABLE_THRESHOLD) continue;
    const attackers = chess.attackers(p.square, our);
    for (const fSq of attackers) {
      if (!out.has(fSq)) out.set(fSq, new Set());
      out.get(fSq)!.add(p.square);
    }
  }
  return out;
}

export function findFork(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  const attacksBefore = collectAttacksByPiece(chess, our, enemy);

  // KS-2408 буфера для отчётности:
  //   cleanCandidates — ходы, прошедшие overlap-фильтр (≥2 новых целей,
  //     intersection с before = ∅).
  //   safeCandidates — cleanCandidates ∩ safe (KS-2406).
  //   overlapBlockedMoves — ходы, у которых был форкер с |targets|≥2
  //     в After, но intersection с targetsBefore по oldSquare ≠ ∅.
  //     Используется только для reason='overlap-with-previous-attacks',
  //     если cleanCandidates пуст.
  const cleanCandidates: { from: string; to: string }[] = [];
  const safeCandidates: { from: string; to: string }[] = [];
  let overlapBlockedCount = 0;

  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    const attacksAfter = collectAttacksByPiece(chess, our, enemy);

    // Ищем хотя бы одну нашу фигуру F с |targetsAfter[F]|≥2 и
    // intersection ∅. Параллельно фиксируем флаг overlap-only.
    let hasClean = false;
    let hasOverlapForker = false;
    for (const [forkerSq, targets] of attacksAfter) {
      if (targets.size < 2) continue;
      // KS-2408: соответствие «тот же форкер» по клетке. Ходящая
      // фигура изменила клетку m.from → m.to; discovered не двигался.
      const oldSquare = forkerSq === m.to ? m.from : forkerSq;
      const before = attacksBefore.get(oldSquare);
      let overlap = false;
      if (before) {
        for (const t of targets) {
          if (before.has(t)) {
            overlap = true;
            break;
          }
        }
      }
      if (overlap) {
        hasOverlapForker = true;
      } else {
        hasClean = true;
        break; // достаточно одного clean-форкера для creator-кандидата
      }
    }

    let forkerSafe = false;
    if (hasClean) {
      // KS-2406 safety: «есть хоть один enemy-attacker на m.to → drop».
      // Применяется только к creator-кандидатам — overlap-only ходы
      // отсекаются раньше.
      const enemyAttackers = chess.attackers(m.to, enemy);
      forkerSafe = enemyAttackers.length === 0;
    }
    chess.undo();

    if (hasClean) {
      cleanCandidates.push({ from: m.from, to: m.to });
      if (forkerSafe) safeCandidates.push({ from: m.from, to: m.to });
    } else if (hasOverlapForker) {
      overlapBlockedCount += 1;
    }
  }

  if (safeCandidates.length !== 1) {
    // KS-2408: clean-creator'ов нет, но кто-то отбит overlap'ом —
    // отдельный reason для счётчика индексера.
    if (cleanCandidates.length === 0 && overlapBlockedCount > 0) {
      return {
        valid: false,
        reason: 'overlap-with-previous-attacks',
      };
    }
    // KS-2406: clean был, но все unsafe.
    if (cleanCandidates.length > 0 && safeCandidates.length === 0) {
      return {
        valid: false,
        reason: 'unsafe-forker',
      };
    }
    return {
      valid: false,
      reason: `expected exactly 1 fork-creating move, found ${safeCandidates.length}`,
    };
  }

  const answer: AnswerMove = {
    shape: 'move',
    from: safeCandidates[0].from,
    to: safeCandidates[0].to,
  };
  return { valid: true, answer };
}
