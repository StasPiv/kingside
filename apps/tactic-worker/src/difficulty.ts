/**
 * KS-2225 (formula) / KS-2229 (indexer use). Difficulty computation
 * для tactic-drill — реализация по methodology §9 (psevdocode §9.10).
 *
 * Двухступенчатый rollout:
 *   - **v1** — стартовая формула (`0.30·pc + 0.30·ad + 0.40·typeSpecific_v1`),
 *     не требует тяжёлых predicates (`hasBattery`, `mateType` enum'ы и
 *     т.п.). Используется по умолчанию (CLI-флаг `--difficulty-version=v1`).
 *   - **full** — полная формула с distractor-count, materialBalance,
 *     mobilityRatio и расширенным `typeSpecific_full`. На v1 этапе
 *     `typeSpecific_full` вычисляется как fallback на `_v1` (TODO в
 *     отдельном тикете KS-DRILL-DIFFICULTY-FULL).
 *
 * Bucket-cuts (§9.6) фиксированы при cold start: 0.20 / 0.35 / 0.55 / 0.75.
 * Калибруются после ≥5000 решений per drill-type — двигаются cuts, не веса.
 */

import type { Chess } from 'chess.js';
import type { AnswerData, TacticDrillType } from '@kingside/shared';
import { allPieces, oppColor } from './predicates/types';

// ─── Веса (methodology §9.5) ─────────────────────────────────────────

export const WEIGHTS_FULL: Record<
  TacticDrillType,
  { pc: number; ad: number; dc: number; ts: number }
> = {
  'count-attackers':         { pc: 0.15, ad: 0.30, dc: 0.05, ts: 0.40 },
  'find-loose-piece':        { pc: 0.25, ad: 0.15, dc: 0.40, ts: 0.10 },
  'find-hanging-piece':      { pc: 0.20, ad: 0.25, dc: 0.30, ts: 0.15 },
  'find-all-checks':         { pc: 0.15, ad: 0.20, dc: 0.10, ts: 0.45 },
  'find-pin':                { pc: 0.15, ad: 0.20, dc: 0.15, ts: 0.40 },
  'find-fork':               { pc: 0.15, ad: 0.30, dc: 0.15, ts: 0.30 },
  // KS-2393: запись `mate-in-1 (deprecated)` удалена.
  'find-undefended-attack':  { pc: 0.25, ad: 0.20, dc: 0.20, ts: 0.25 },
};

// ─── Универсальные нормализации в [0..1] (methodology §9.4) ─────────

export function fPieceCount(chess: Chess): number {
  const total = allPieces(chess).filter((p) => p.type !== 'k').length;
  if (total <= 10) return 0.10;
  if (total <= 16) return 0.30;
  if (total <= 22) return 0.60;
  if (total <= 28) return 0.85;
  return 1.0;
}

export function fAttackerDensity(chess: Chess): number {
  const pieces = allPieces(chess);
  if (pieces.length === 0) return 0.10;
  let totalAttacks = 0;
  for (const p of pieces) {
    totalAttacks +=
      chess.attackers(p.square, 'w').length +
      chess.attackers(p.square, 'b').length;
  }
  const density = totalAttacks / pieces.length;
  if (density < 0.4) return 0.10;
  if (density < 0.8) return 0.30;
  if (density < 1.3) return 0.60;
  if (density < 1.8) return 0.85;
  return 1.0;
}

const PAWN_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0, // король в материальный баланс не входит
};

export function fMaterialBalance(chess: Chess): number {
  let white = 0;
  let black = 0;
  for (const p of allPieces(chess)) {
    const v = PAWN_VALUE[p.type];
    if (p.color === 'w') white += v;
    else black += v;
  }
  const diff = Math.abs(white - black);
  if (diff <= 1) return 1.0;
  if (diff < 3) return 0.6;
  if (diff < 6) return 0.3;
  return 0.1;
}

export function fMobilityRatio(chess: Chess): number {
  const our = chess.moves().length;
  // У оппонента ходов нет с точки зрения chess.js (turn). Считаем
  // через временное переключение turn — но chess.js не разрешает.
  // Используем нижнюю оценку: pseudo-legal через перебор всех piece
  // attacks обратной стороны (упрощение). Для drill-индексера это
  // достаточный proxy: точная игровая mobility не критична для
  // bucket-cut'ов.
  const enemy = oppColor(chess.turn());
  let theirMoves = 0;
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    // attackers — обратная функция: считаем клетки, на которые фигура
    // атакует. Прибл.: сумма `attackers(<every-square>, enemy)` где
    // p.square лежит в атакующих. Для упрощения считаем сами клетки
    // которые видит фигура — через перебор всех 64 квадратов.
    // (Дешёвое приближение, не точное.)
    theirMoves += countSquaresAttackedBy(chess, p.square);
  }
  if (our === 0 && theirMoves === 0) return 0.4;
  const ratio = theirMoves === 0 ? 2 : our / theirMoves;
  if (ratio < 0.5) return 0.2;
  if (ratio <= 1.5) return 1.0;
  return 0.4;
}

function countSquaresAttackedBy(chess: Chess, fromSq: string): number {
  // attackers(target, color) возвращает клетки фигур цвета color,
  // атакующих target. Перебираем target по 64 клеткам, считаем сколько
  // содержат fromSq.
  const piece = chess.get(fromSq as never);
  if (!piece) return 0;
  let count = 0;
  for (const file of 'abcdefgh') {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = `${file}${rank}` as never;
      if (sq === fromSq) continue;
      if (chess.attackers(sq, piece.color).includes(fromSq as never)) count++;
    }
  }
  return count;
}

export function fDistractorCount(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 0.3;
  if (count <= 4) return 0.6;
  return 0.9;
}

// ─── typeSpecific_v1 (methodology §9.7) ─────────────────────────────

export function fTypeSpecificV1(
  drillType: TacticDrillType,
  chess: Chess,
  answer: AnswerData,
): number {
  switch (drillType) {
    case 'count-attackers': {
      // value=1→0, 2→0.33, 3→0.66, 4→1.0
      if (answer.shape !== 'number') return 0;
      const map = [0, 0, 0.33, 0.66, 1.0];
      return map[answer.value] ?? 0;
    }
    case 'find-all-checks': {
      // N=2→0.2, 3→0.4, 4→0.6, 5→0.8, ≥6→1.0
      if (answer.shape !== 'squares') return 0;
      const N = answer.squares.length;
      if (N <= 2) return 0.2;
      if (N === 3) return 0.4;
      if (N === 4) return 0.6;
      if (N === 5) return 0.8;
      return 1.0;
    }
    case 'find-pin': {
      // depth/7. Считаем дистанцию между связанной фигурой и королём.
      if (answer.shape !== 'square') return 0;
      const piece = chess.get(answer.square as never);
      if (!piece) return 0;
      const kingSq = findKingSqLocal(chess, piece.color);
      if (!kingSq) return 0;
      const depth = chebyshevDistance(answer.square, kingSq);
      return Math.min(depth, 7) / 7;
    }
    case 'find-fork': {
      // KS-2400: после миграции на shape='move' forker — наша фигура,
      // стоящая на клетке `answer.to` ПОСЛЕ хода. Считаем
      // targetsValueSum по позиции после apply/undo.
      // targetsValueSum: ≤6→0.3, 7-10→0.6, ≥11→1.0.
      if (answer.shape !== 'move') return 0;
      const our = chess.turn();
      const enemy = oppColor(our);
      let sum = 0;
      try {
        chess.move({ from: answer.from, to: answer.to });
      } catch {
        return 0;
      }
      try {
        for (const p of allPieces(chess)) {
          if (p.color !== enemy) continue;
          if ((PAWN_VALUE[p.type] ?? 0) < 3) continue; // только ценные
          const att = chess.attackers(p.square, our);
          if (att.includes(answer.to as never)) sum += PAWN_VALUE[p.type];
        }
      } finally {
        chess.undo();
      }
      if (sum <= 6) return 0.3;
      if (sum <= 10) return 0.6;
      return 1.0;
    }
    // KS-2393: case `mate-in-1 (deprecated)` удалён вместе с типом.
    case 'find-undefended-attack': {
      // attackDistance: 1→0.2, 2-3→0.5, ≥4→1.0
      if (answer.shape !== 'move') return 0;
      const dist = chebyshevDistance(answer.from, answer.to);
      if (dist <= 1) return 0.2;
      if (dist <= 3) return 0.5;
      return 1.0;
    }
    case 'find-loose-piece': {
      // Используем количество «почти-кандидатов» как distractor count.
      // Реальный расчёт (`equal-exchange`/`near-loose`) — в v_full;
      // для v1 берём общее число вражеских не-королевских фигур как
      // прокси: больше фигур → выше distractor-base.
      if (answer.shape !== 'square') return 0;
      const our = chess.turn();
      const enemyCount = allPieces(chess).filter(
        (p) => p.color !== our && p.type !== 'k',
      ).length;
      return fDistractorCount(Math.max(0, enemyCount - 1));
    }
    case 'find-hanging-piece': {
      // KS-2335 / KS-2337: shape='move'. Distractor-proxy остаётся —
      // число вражеских не-королевских фигур как прокси сложности
      // (больше потенциальных целей и взятий → выше bucket-база).
      // Клетка цели берётся из answer.to, но в v1 формуле она не
      // используется напрямую — только счётчик фигур.
      if (answer.shape !== 'move') return 0;
      const our = chess.turn();
      const enemyCount = allPieces(chess).filter(
        (p) => p.color !== our && p.type !== 'k',
      ).length;
      return fDistractorCount(Math.max(0, enemyCount - 1));
    }
    default:
      return 0;
  }
}

// ─── helpers для typeSpecific_v1 ─────────────────────────────────────

function findKingSqLocal(chess: Chess, color: 'w' | 'b'): string | null {
  for (const p of allPieces(chess)) {
    if (p.type === 'k' && p.color === color) return p.square;
  }
  return null;
}

function chebyshevDistance(a: string, b: string): number {
  const fileA = a.charCodeAt(0) - 97;
  const rankA = parseInt(a[1], 10);
  const fileB = b.charCodeAt(0) - 97;
  const rankB = parseInt(b[1], 10);
  return Math.max(Math.abs(fileA - fileB), Math.abs(rankA - rankB));
}

// ─── Главная функция (methodology §9.10) ─────────────────────────────

export interface DrillFactors {
  pieceCount: number;
  attackerDensity: number;
  distractorCount: number;
  materialBalance: number;
  mobilityRatio: number;
  typeSpecific: number;
}

export function computeFactors(
  drillType: TacticDrillType,
  chess: Chess,
  answer: AnswerData,
  version: 'v1' | 'full' = 'v1',
): DrillFactors {
  // v1 нужен только pieceCount, attackerDensity, typeSpecific —
  // остальное вычисляем тоже для прозрачности (но веса 0).
  const pc = fPieceCount(chess);
  const ad = fAttackerDensity(chess);
  const ts = fTypeSpecificV1(drillType, chess, answer);
  if (version === 'v1') {
    return {
      pieceCount: pc,
      attackerDensity: ad,
      distractorCount: 0,
      materialBalance: 0,
      mobilityRatio: 0,
      typeSpecific: ts,
    };
  }
  // full: распирёт. Stub для full: используем те же v1 значения
  // distractorCount получаем из typeSpecific-логики (для drill,
  // где дистрактор — главный фактор, см. KS-DRILL-DIFFICULTY-FULL).
  const dc = fDistractorCount(0); // placeholder для v1.5
  return {
    pieceCount: pc,
    attackerDensity: ad,
    distractorCount: dc,
    materialBalance: fMaterialBalance(chess),
    mobilityRatio: fMobilityRatio(chess),
    typeSpecific: ts,
  };
}

export function computeDifficultyScore(
  drillType: TacticDrillType,
  factors: DrillFactors,
  version: 'v1' | 'full' = 'v1',
): number {
  if (version === 'v1') {
    return (
      0.30 * factors.pieceCount +
      0.30 * factors.attackerDensity +
      0.40 * factors.typeSpecific
    );
  }
  const w = WEIGHTS_FULL[drillType];
  return (
    w.pc * factors.pieceCount +
    w.ad * factors.attackerDensity +
    w.dc * factors.distractorCount +
    w.ts * factors.typeSpecific +
    0.05 * factors.materialBalance +
    0.05 * factors.mobilityRatio
  );
}

/** Bucket-cuts (§9.6). 0.20 / 0.35 / 0.55 / 0.75 → 1..5. */
export function scoreToBucket(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score < 0.20) return 1;
  if (score < 0.35) return 2;
  if (score < 0.55) return 3;
  if (score < 0.75) return 4;
  return 5;
}

export function computeDifficulty(
  drillType: TacticDrillType,
  chess: Chess,
  answer: AnswerData,
  version: 'v1' | 'full' = 'v1',
): { score: number; bucket: 1 | 2 | 3 | 4 | 5; factors: DrillFactors } {
  const factors = computeFactors(drillType, chess, answer, version);
  const score = computeDifficultyScore(drillType, factors, version);
  return { score, bucket: scoreToBucket(score), factors };
}
