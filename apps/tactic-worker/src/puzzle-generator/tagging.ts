/**
 * KS-2431 / ADR-041 §4. Теги для сгенерированного puzzle.
 *
 * Источники тегов:
 *   а) Drill predicates (`apps/tactic-worker/src/predicates/`) — даёт
 *      теги `fork`, `pin`, `hangingPiece`, `hangingCreation` если
 *      позиция начала puzzle и первый ход линии «попадают» в strict
 *      drill-семантику (после KS-2406/2408/2419 false-positive ≈ 0).
 *   б) Алгоритмические теги — длина линии, тип финального исхода
 *      (`mate` / `crushing` / `advantage`), материальный sacrifice
 *      на первом ходе (`sacrifice`), фаза партии
 *      (`opening`/`middlegame`/`endgame` — KS-3562 / ADR-094 §3.1),
 *      фигура-исполнитель.
 *   в) `mateInN`, `mateIn1` / `mateIn2` — отдельно (для UI-фильтра).
 *
 * Drill-predicate'ы могут быть тяжёлыми; для tagging'а используется
 * только стартовая позиция puzzle (1 запуск каждого predicate).
 */
import { Chess } from 'chess.js';
import { findFork } from '../predicates/find-fork';
import { findPin } from '../predicates/find-pin';
import { findHangingPiece } from '../predicates/find-hanging-piece';
import { findUndefendedAttack } from '../predicates/find-undefended-attack';
import { allPieces, PIECE_VALUE } from '../predicates/types';

/** KS-3562 / ADR-094 §3.1. Фаза партии для puzzle-tagging'а. */
export type Phase = 'opening' | 'middlegame' | 'endgame';

/**
 * KS-3562 / ADR-094 §3.1. Определение фазы партии по FEN.
 * Возвращает РОВНО ОДНО значение из union'а — фазы взаимоисключающие.
 *
 * Правила (по приоритету):
 *  1. `endgame` если `total ≤ 5` нон-кинг ИЛИ
 *     (`queens === 0 AND nonPawn ≤ 6`). Проверяется ПЕРВЫМ —
 *     быстрый размен материала к 8-му ходу должен дать `endgame`,
 *     а не `opening`.
 *  2. `opening` если `fullmove ≤ 12`.
 *  3. Иначе `middlegame`.
 *
 * Старая логика (KS-2431 / ADR-041 §4) использовала `total ≤ 7`
 * включая королей — эквивалент `total ≤ 5` нон-кинг (back-compat).
 * Расширение KS-3562: добавляется ветка «нет ферзей + лёгкий
 * материал» под классический эндшпиль.
 */
export function detectPhase(fen: string): Phase {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);
  const nonKing = pieces.filter((p) => p.type !== 'k');
  const total = nonKing.length;
  const queens = nonKing.filter((p) => p.type === 'q').length;
  const nonPawn = nonKing.filter((p) => p.type !== 'p').length;
  const fullmoveRaw = fen.split(' ')[5];
  const fullmove =
    fullmoveRaw && Number.isFinite(Number(fullmoveRaw))
      ? Number(fullmoveRaw)
      : 1;

  if (total <= 5) return 'endgame';
  if (queens === 0 && nonPawn <= 6) return 'endgame';

  if (fullmove <= 12) return 'opening';
  return 'middlegame';
}

/**
 * KS-3567 / ADR-094 §8.3. Подвид эндшпиля для уже-проставленного
 * `endgame`-тега.
 *
 * 5 чистых подвидов + queenRookEndgame:
 *  - `pawnEndgame`        — на доске только пешки (плюс короли).
 *  - `rookEndgame`        — единственный нон-пешечный тип — ладьи.
 *  - `queenEndgame`       — единственный нон-пешечный тип — ферзи.
 *  - `knightEndgame`      — единственный нон-пешечный тип — кони.
 *  - `bishopEndgame`      — единственный нон-пешечный тип — слоны.
 *  - `queenRookEndgame`   — на доске ровно `{q, r}` без других тяжёлых
 *                            или лёгких фигур. Особый «зонтичный»
 *                            подвид: согласно ADR-094 §8.3 это самый
 *                            частый смешанный эндшпиль и заслуживает
 *                            отдельной метки.
 *
 * Если на доске встречаются другие смеси типов (R+N, B+N, Q+B, Q+N,
 * Q+R+B и т.п.) — `null`: подвид не выставляется, остаётся только
 * зонтичный `endgame`.
 *
 * Не учитываем цвет — считаем подмножество `{q,r,b,n}` совокупно
 * по обеим сторонам. ADR-094 §8.3 явно: «подвид по типам на доске
 * целиком, не по балансу сторон».
 */
export type EndgameSubtype =
  | 'pawnEndgame'
  | 'rookEndgame'
  | 'queenEndgame'
  | 'knightEndgame'
  | 'bishopEndgame'
  | 'queenRookEndgame';

export function detectEndgameSubtype(fen: string): EndgameSubtype | null {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);
  const heavyOrMinor = pieces.filter(
    (p) => p.type !== 'p' && p.type !== 'k',
  );
  const types = new Set(heavyOrMinor.map((p) => p.type));

  if (types.size === 0) return 'pawnEndgame';
  if (types.size === 1) {
    const only = [...types][0];
    if (only === 'r') return 'rookEndgame';
    if (only === 'q') return 'queenEndgame';
    if (only === 'n') return 'knightEndgame';
    if (only === 'b') return 'bishopEndgame';
  }
  if (types.size === 2 && types.has('q') && types.has('r')) {
    return 'queenRookEndgame';
  }
  return null;
}

export interface TagInput {
  /** Стартовая FEN puzzle. */
  startFen: string;
  /** UCI-ходы линии (включая первый «решающий»). */
  moves: string[];
  /** Финальная eval (cp) от лица решающей стороны. */
  finalCpForSolver: number;
  /** Линия закончилась матом? */
  endsInMate: boolean;
}

const PIECE_TAG: Record<string, string> = {
  p: 'pawnMove',
  n: 'knightMove',
  b: 'bishopMove',
  r: 'rookMove',
  q: 'queenMove',
  k: 'kingMove',
};

export function computeTags(input: TagInput): string[] {
  const tags = new Set<string>();
  const { startFen, moves, finalCpForSolver, endsInMate } = input;
  const firstMove = moves[0];

  // (а) Drill predicates на стартовой позиции.
  if (firstMove) {
    safe(() => {
      const r = findFork(startFen);
      if (r.valid && r.answer.shape === 'move') {
        const ans = `${r.answer.from}${r.answer.to}${r.answer.promotion ?? ''}`;
        if (matchesUci(firstMove, ans)) tags.add('fork');
      }
    });
    safe(() => {
      const r = findPin(startFen);
      if (r.valid) tags.add('pin');
    });
    safe(() => {
      const r = findHangingPiece(startFen);
      if (r.valid && r.answer.shape === 'move') {
        const ans = `${r.answer.from}${r.answer.to}${r.answer.promotion ?? ''}`;
        if (matchesUci(firstMove, ans)) tags.add('hangingPiece');
      }
    });
    safe(() => {
      const r = findUndefendedAttack(startFen);
      if (r.valid && r.answer.shape === 'move') {
        const ans = `${r.answer.from}${r.answer.to}${r.answer.promotion ?? ''}`;
        if (matchesUci(firstMove, ans)) tags.add('hangingCreation');
      }
    });
  }

  // (б, в) Алгоритмические теги.
  // Длина линии в полных ходах (round up) — для mateInN.
  if (endsInMate) {
    tags.add('mate');
    const fullMovesToMate = Math.ceil(moves.length / 2);
    if (fullMovesToMate === 1) tags.add('mateIn1');
    else if (fullMovesToMate === 2) tags.add('mateIn2');
    else if (fullMovesToMate === 3) tags.add('mateIn3');
    else if (fullMovesToMate >= 4) tags.add('mateInN');
  } else {
    if (finalCpForSolver >= 500) tags.add('crushing');
    else if (finalCpForSolver >= 200) tags.add('advantage');
  }

  // Sacrifice: первый ход — наша фигура отдаётся (захват противником
  // на этой клетке возможен, и SEE для нашей фигуры < 0). MVP-эвристика:
  // если на клетке `to` после нашего хода стоит ценная наша фигура и
  // её атакует более дешёвая фигура противника, и наша незащищена —
  // считается жертвой.
  safe(() => {
    if (firstMove && firstMove.length >= 4) {
      const to = firstMove.slice(2, 4);
      const chess = new Chess(startFen);
      try {
        chess.move({
          from: firstMove.slice(0, 2),
          to,
          ...(firstMove.length > 4
            ? { promotion: firstMove[4] as 'q' | 'r' | 'b' | 'n' }
            : {}),
        });
      } catch {
        return;
      }
      const piece = chess.get(to as never);
      if (!piece) return;
      const enemy = piece.color === 'w' ? 'b' : 'w';
      const attackers = chess.attackers(to as never, enemy);
      if (attackers.length === 0) return;
      // Самый дешёвый атакующий
      let cheapestAttackerVal = Infinity;
      for (const sq of attackers) {
        const a = chess.get(sq as never);
        if (a) {
          const v = PIECE_VALUE[a.type] ?? 0;
          if (v < cheapestAttackerVal) cheapestAttackerVal = v;
        }
      }
      const ourVal = PIECE_VALUE[piece.type] ?? 0;
      if (cheapestAttackerVal < ourVal) {
        tags.add('sacrifice');
      }
    }
  });

  // KS-3562 / ADR-094 §3.1. Фаза партии — ровно один из
  // opening / middlegame / endgame, взаимоисключающие.
  // KS-3567 / ADR-094 §8.3. Если фаза = endgame — добавляем подвид
  // (pawn/rook/queen/knight/bishop/queenRookEndgame). Смешанные
  // комбо без специфичного подвида — только зонтичный `endgame`.
  safe(() => {
    const phase = detectPhase(startFen);
    tags.add(phase);
    if (phase === 'endgame') {
      const subtype = detectEndgameSubtype(startFen);
      if (subtype) tags.add(subtype);
    }
  });

  // Фигура-исполнитель.
  safe(() => {
    if (firstMove && firstMove.length >= 4) {
      const chess = new Chess(startFen);
      const from = firstMove.slice(0, 2);
      const piece = chess.get(from as never);
      if (piece) {
        const tag = PIECE_TAG[piece.type];
        if (tag) tags.add(tag);
      }
    }
  });

  return Array.from(tags).sort();
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // tagging — best-effort, ошибка предиката не должна валить puzzle
  }
}

function matchesUci(actual: string, expected: string): boolean {
  // оба формата: `e2e4`, `e7e8q`. Учитываем что promotion может быть
  // в одном из, но не в другом.
  return actual.slice(0, 4) === expected.slice(0, 4);
}
