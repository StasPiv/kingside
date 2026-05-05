/**
 * KS-2227 / KS-2399 / KS-2400 / KS-2406 — `find-fork`.
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
 *      d. KS-2406: проверить, что фигура-форкер на m.to **в безопасности** —
 *         нет ни одного прямого атакующего противника (см. ниже).
 *      e. undo.
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
 *
 * KS-2406 — safety-check форкера. Запрос пользователя: «если фигура
 * ставит вилку — она не должна вставать под бой». До патча predicate
 * считал валидным и Qxh7 с вилкой, где ферзь сам тут же берётся —
 * это тренирует зевок, а не тактику. Простая v1-реализация: если на
 * клетке `m.to` после хода есть хотя бы один прямой атакующий
 * противника (`chess.attackers(to, enemy).length > 0`) — кандидат
 * отбрасывается. SEE/X-ray сейчас не используется (из KS-2339 общая
 * утилита не вынесена). Промежуточный кейс «форкер атакован, но
 * защищён равной фигурой» в этой простой версии тоже отбрасывается —
 * консервативно, согласовано в задаче. Король-форкер не требует
 * отдельной проверки: chess.js не позволит ходу под шах.
 *
 * Дополнительно возвращаем `reason: 'unsafe-forker'` если до safety-
 * фильтра был ровно 1 кандидат с новой вилкой, а после фильтра
 * остался 0 — индексер использует это для счётчика отсева в логах.
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

  // KS-2406: считаем кандидатов до и после safety-фильтра, чтобы
  // отличать «не было вилки вообще» от «вилка была, но форкер вис».
  const forkCreating: { from: string; to: string }[] = [];
  const safeCandidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    const forksAfter = collectForks(chess, our, enemy);

    let createsNew = false;
    for (const sq of forksAfter) {
      if (!forksBefore.has(sq)) {
        createsNew = true;
        break;
      }
    }
    let forkerSafe = false;
    if (createsNew) {
      // KS-2406 safety: «есть хоть один enemy-attacker на m.to → drop».
      // chess.attackers сам учитывает геометрию после хода (включая
      // вскрывшиеся линии); SEE не используется (см. JSDoc).
      const enemyAttackers = chess.attackers(m.to, enemy);
      forkerSafe = enemyAttackers.length === 0;
    }
    chess.undo();

    if (createsNew) {
      forkCreating.push({ from: m.from, to: m.to });
      if (forkerSafe) safeCandidates.push({ from: m.from, to: m.to });
    }
  }

  if (safeCandidates.length !== 1) {
    // Особый случай для индексера: были fork-creating ходы, но все
    // отсеялись safety-фильтром. Помечаем reason'ом, чтобы считать
    // частоту таких отсевов отдельно от обычных drop'ов.
    if (forkCreating.length > 0 && safeCandidates.length === 0) {
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
