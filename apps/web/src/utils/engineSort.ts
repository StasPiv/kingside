/**
 * KS-3593 (ADR-098). Сортировка линий engine-panel по выбранному
 * режиму:
 *  - `stockfish`: исходный порядок Stockfish (eval desc, tiebreak
 *    по `multipv` asc — это и есть «как пришло»).
 *  - `maia`: вероятность хода от Maia desc, tiebreak1 eval desc,
 *    tiebreak2 multipv asc. `undefined` → конец стабильно.
 *
 * Возвращает НОВЫЙ массив; исходный не мутирует.
 */
import type { EvalLine } from '../hooks/useStockfish';

export type SortMode = 'stockfish' | 'maia';

/**
 * Извлекает первый UCI-ход из PV. Production `EvalLine.pv` — строка
 * с пробелами («e2e4 e7e5 …»). Часть unit-тестов передаёт `pv`
 * массивом строк (AnalysisSidebar.test KS-2866) — поддерживаем оба
 * варианта defensive'но.
 */
export function extractBestUci(pv: unknown): string | null {
  if (typeof pv === 'string') {
    const first = pv.split(' ')[0];
    return first ? first : null;
  }
  if (Array.isArray(pv) && pv.length > 0 && typeof pv[0] === 'string') {
    return pv[0];
  }
  return null;
}

/**
 * Сравнение двух `EvalLine` по eval (desc). Возвращает <0 если `a`
 * лучше для side-to-move (после Stockfish-конвенции), >0 если `b`
 * лучше, 0 если эквивалентно.
 *
 * Правила (Stockfish конвенция: положительный score = выгода stm):
 *  - оба cp: больший cp лучше → desc по value.
 *  - оба mate: положительный mate (мат для stm) бьёт отрицательный
 *    (мат против stm). Внутри одной стороны — ближе к мату лучше:
 *      mate +N лучше mate +M если |N| < |M| (быстрее матуем);
 *      mate −N (нас матуют) лучше mate −M если |N| > |M| (дольше
 *      нас матуют, у соперника меньше преимущества).
 *  - смешанно: положительный mate лучше любого cp; отрицательный
 *    mate хуже любого cp.
 */
export function evalCompare(a: EvalLine, b: EvalLine): number {
  const aMate = a.score.type === 'mate';
  const bMate = b.score.type === 'mate';

  if (aMate && bMate) {
    const av = a.score.value;
    const bv = b.score.value;
    // Знак говорит за чью сторону мат (Stockfish: + → за stm).
    const aSign = Math.sign(av);
    const bSign = Math.sign(bv);
    if (aSign !== bSign) return bSign - aSign; // + бьёт − → больше знак лучше → desc
    // Один знак: при + хочем меньший |value| (быстрее матуем);
    // при − хочем больший |value| (дольше нас матуют).
    if (aSign >= 0) return Math.abs(av) - Math.abs(bv);
    return Math.abs(bv) - Math.abs(av);
  }

  if (aMate) {
    return a.score.value > 0 ? -1 : 1; // + mate бьёт cp, − mate хуже
  }
  if (bMate) {
    return b.score.value > 0 ? 1 : -1;
  }

  return b.score.value - a.score.value; // desc cp
}

/**
 * Tiebreak для стабильной сортировки — исходный multipv (asc).
 */
function multipvAsc(a: EvalLine, b: EvalLine): number {
  return a.multipv - b.multipv;
}

export function sortLines(
  lines: readonly EvalLine[],
  mode: SortMode,
  getProb: (uci: string) => number | undefined,
): EvalLine[] {
  const copy = lines.slice();
  if (mode === 'stockfish') {
    copy.sort((a, b) => {
      const e = evalCompare(a, b);
      if (e !== 0) return e;
      return multipvAsc(a, b);
    });
    return copy;
  }

  // mode === 'maia'
  copy.sort((a, b) => {
    const ap = getProb(extractBestUci(a.pv) ?? '');
    const bp = getProb(extractBestUci(b.pv) ?? '');
    // undefined → −1 (в конец стабильно).
    const aKey = ap == null ? -1 : ap;
    const bKey = bp == null ? -1 : bp;
    if (aKey !== bKey) return bKey - aKey; // desc по probability
    const e = evalCompare(a, b);
    if (e !== 0) return e;
    return multipvAsc(a, b);
  });
  return copy;
}
