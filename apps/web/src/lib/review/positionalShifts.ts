/**
 * KS-3628 / ADR-103 rev 3 §6.5 — pure-функция перевода дельты classical
 * eval Stockfish 15.1/16 в позиционные ярлыки (`PositionalShiftId`,
 * 19 категорий из `packages/shared`).
 *
 * Алгоритм:
 *   1. Разность по 13 терминам, POV ходящей стороны.
 *   2. По stage (opening/middlegame → MG, endgame → EG).
 *   3. Фильтр `abs(delta) >= MIN_DELTA` (0.10 pawn units).
 *   4. Сортировка по `abs(delta)` убыванию, top-N (TOP_N=2).
 *   5. Маппинг в `PositionalShiftId`.
 *   6. Дедупликация с явными фактами:
 *      - `material_gained` подавляется, если есть `material_change`;
 *      - `threats_grew` — если есть `threats_created.wins_material`.
 *
 * Без вызова движка. Тестируется на синтетических снимках breakdown.
 */
import type {
  FactsInput,
  PositionalShiftId,
} from '@kingside/shared';

import type { GameStage, Side } from './extractFacts';

/** 13 терминов classical eval Stockfish 15.1/16. */
export type ClassicalEvalTerm =
  | 'material'
  | 'imbalance'
  | 'pawns'
  | 'knights'
  | 'bishops'
  | 'rooks'
  | 'queens'
  | 'mobility'
  | 'king_safety'
  | 'threats'
  | 'passed'
  | 'space'
  | 'winnable';

export interface TermPair {
  mg: number;
  eg: number;
}

export interface TermBreakdown {
  white: TermPair;
  black: TermPair;
  /** Total = White − Black (POV white). `null` для терминов где SF
   *  выводит `---- ----` (Material/Imbalance/Total строки). */
  total: TermPair | null;
}

/** Разбор вывода `eval` (см. positionalEval.ts). */
export interface ClassicalEvalBreakdown {
  terms: Record<ClassicalEvalTerm, TermBreakdown>;
  /** «Final evaluation +0.00 (white side)» — POV white, pawn units. */
  final: number | null;
}

/** Параметры алгоритма (ADR-103 §6.5). */
export const POSITIONAL_SHIFTS_MIN_DELTA = 0.1;
export const POSITIONAL_SHIFTS_TOP_N = 2;

interface ShiftCandidate {
  term: ClassicalEvalTerm;
  delta: number;
  id: PositionalShiftId;
}

/**
 * Маппинг (term, sign) → PositionalShiftId. Для «парных» терминов
 * (material, pawns, bishops, mobility, king_safety, threats, winnable)
 * есть и +ID, и −ID. Для «однонаправленных» (knights, rooks, queens,
 * passed, space) ID есть только на +; на − возвращаем null (ярлык
 * не генерируется, кандидат отбрасывается).
 */
function pickShiftId(
  term: ClassicalEvalTerm,
  delta: number,
): PositionalShiftId | null {
  const positive = delta > 0;
  switch (term) {
    case 'material':
      return positive ? 'material_gained' : 'material_lost';
    case 'imbalance':
      // Imbalance — производное от материала; маппим в material_*.
      return positive ? 'material_gained' : 'material_lost';
    case 'pawns':
      return positive ? 'pawn_structure_improved' : 'pawn_structure_weakened';
    case 'knights':
      return positive ? 'knight_more_active' : null;
    case 'bishops':
      return positive ? 'bishop_more_active' : 'bishop_passive';
    case 'rooks':
      return positive ? 'rook_on_open_file' : null;
    case 'queens':
      return positive ? 'queen_more_active' : null;
    case 'mobility':
      return positive ? 'mobility_increased' : 'mobility_decreased';
    case 'king_safety':
      return positive ? 'king_safer' : 'king_exposed';
    case 'threats':
      return positive ? 'threats_grew' : 'threats_weakened';
    case 'passed':
      return positive ? 'passed_pawn_strong' : null;
    case 'space':
      return positive ? 'space_gained' : null;
    case 'winnable':
      return positive
        ? 'position_more_winnable'
        : 'position_less_winnable';
    default:
      return null;
  }
}

/**
 * Берём total-значение из breakdown для нужной фазы (MG/EG). Если
 * total отсутствует (SF выводит `----`), вычисляем как `white − black`.
 */
function readTermValue(
  bd: TermBreakdown,
  col: 'mg' | 'eg',
): number {
  if (bd.total) return bd.total[col];
  return bd.white[col] - bd.black[col];
}

/**
 * Минимально достаточный shape фактов для дедупликации.
 * Берём только то, что реально используется — не привязываемся к
 * полному `FactsInput`.
 */
export type PositionalShiftsFactsContext = Pick<
  FactsInput,
  'material_change' | 'threats_created'
>;

/**
 * Главная функция. Параметры:
 * - `evalBefore`, `evalAfter` — разбор `eval` для FEN до/после played-хода
 *   (т.е. side тот, кто только что сыграл; «после» — позиция, на ходу противник).
 * - `stage` — берём из `FactsInput.stage`.
 * - `sideToMove` — сторона, которая сделала ход (`FactsInput.side`).
 * - `facts` — для дедупликации с явными материальными/угроза-фактами.
 */
export function computePositionalShifts(
  evalBefore: ClassicalEvalBreakdown,
  evalAfter: ClassicalEvalBreakdown,
  stage: GameStage,
  sideToMove: Side,
  facts: PositionalShiftsFactsContext,
): PositionalShiftId[] {
  const col: 'mg' | 'eg' = stage === 'endgame' ? 'eg' : 'mg';
  // POV: white видит total как есть, black — инвертирует.
  const povSign = sideToMove === 'white' ? 1 : -1;

  const terms: ClassicalEvalTerm[] = [
    'material',
    'imbalance',
    'pawns',
    'knights',
    'bishops',
    'rooks',
    'queens',
    'mobility',
    'king_safety',
    'threats',
    'passed',
    'space',
    'winnable',
  ];

  const candidates: ShiftCandidate[] = [];
  for (const term of terms) {
    const after = readTermValue(evalAfter.terms[term], col);
    const before = readTermValue(evalBefore.terms[term], col);
    // Delta в POV ходящего: after − before.
    const delta = (after - before) * povSign;
    if (Math.abs(delta) < POSITIONAL_SHIFTS_MIN_DELTA) continue;
    const id = pickShiftId(term, delta);
    if (!id) continue;
    candidates.push({ term, delta, id });
  }

  // Сортировка по |delta| убыванию.
  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Дедупликация ID — несколько терминов могут привести к одному и
  // тому же ID (например, material + imbalance → material_gained).
  // Берём только первое вхождение.
  const seen = new Set<PositionalShiftId>();
  const dedupedById = candidates.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  // Дедупликация с явными фактами:
  //   - material_gained / material_lost → если material_change уже есть.
  //   - threats_grew → если threats_created.wins_material есть.
  const hasMaterialChange = facts.material_change != null;
  const hasWinsMaterial =
    facts.threats_created && facts.threats_created.wins_material != null;
  const dedupedByFacts = dedupedById.filter((c) => {
    if (
      hasMaterialChange &&
      (c.id === 'material_gained' || c.id === 'material_lost')
    ) {
      return false;
    }
    if (hasWinsMaterial && c.id === 'threats_grew') return false;
    return true;
  });

  return dedupedByFacts.slice(0, POSITIONAL_SHIFTS_TOP_N).map((c) => c.id);
}
