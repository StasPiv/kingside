/**
 * KS-2227 / KS-2372 / KS-2419 / KS-2455.
 *
 * Pure-функция: вычисляет «новые висящие угрозы» после применения хода.
 *
 * Семантика: фигура противника **не короля**, попавшая под бой нашей
 * фигуры после хода и не имеющая защитников, причём такого состояния
 * у неё не было до хода. Если фигура уже висела — это пассивная
 * висящая, не «создание угрозы».
 *
 * Helper НЕ выполняет safety-check атакующей фигуры (KS-2419 — наличие
 * enemy-attacker'а на `m.to`): это семантика predicate'а уровня
 * выше. Helper отдаёт чистое множество «новых клеток» — потребитель
 * (backend predicate, frontend explanation) решает, как фильтровать.
 *
 * Перенесено из `apps/api/src/tactic-drill/predicates/find-undefended-
 * attack.ts` в shared (KS-2455).
 */

import { Chess, type Color } from 'chess.js';

export interface UndefendedAttackResult {
  /** Клетки enemy-фигур, ставших висящими после применения хода. */
  newThreats: string[];
}

export interface UndefendedAttackMoveInput {
  from: string;
  to: string;
  promotion?: string;
}

function collectUndefendedThreats(
  chess: Chess,
  our: Color,
  enemy: Color,
): Set<string> {
  const out = new Set<string>();
  const board = chess.board();
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      if (piece.color !== enemy) continue;
      if (piece.type === 'k') continue; // король = шах, не drill
      const attackers = chess.attackers(piece.square, our);
      if (attackers.length < 1) continue;
      const defenders = chess.attackers(piece.square, enemy);
      if (defenders.length > 0) continue;
      out.add(piece.square);
    }
  }
  return out;
}

/**
 * Возвращает массив клеток enemy-фигур, которые после применения хода
 * стали висящими (под боем + без защитников), причём такого состояния
 * у них не было до хода. Если ход некорректен или новых угроз нет —
 * массив пустой.
 *
 * Помещает chess в исходное состояние (`undo`) перед возвратом.
 */
export function computeNewThreatsAfterMove(
  fen: string,
  move: UndefendedAttackMoveInput,
): UndefendedAttackResult {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { newThreats: [] };
  }
  const our = chess.turn();
  const enemy: Color = our === 'w' ? 'b' : 'w';

  const threatsBefore = collectUndefendedThreats(chess, our, enemy);

  try {
    chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });
  } catch {
    return { newThreats: [] };
  }

  const threatsAfter = collectUndefendedThreats(chess, our, enemy);

  const newThreats: string[] = [];
  for (const sq of threatsAfter) {
    if (!threatsBefore.has(sq)) newThreats.push(sq);
  }

  chess.undo();
  return { newThreats };
}
