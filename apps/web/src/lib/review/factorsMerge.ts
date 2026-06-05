/**
 * KS-3699. Объединение позиционных факторов исходной позиции и позиции
 * в конце главной линии (pv) Stockfish 18 в один массив — для отправки
 * языковой модели вместе со сравнительными значениями.
 *
 * Идея: модели полезно видеть не только «как сейчас», но и «как будет
 * через ~20 ходов» по каждому фактору. Чтобы не дублировать запрос и
 * не раздувать payload, склеиваем оба набора в один массив элементов,
 * где у одного и того же фактора лежат и `value_mg/eg`, и
 * `terminal_value_mg/eg`.
 *
 * Объединение — по составному ключу `id|color|square`. По одному только
 * `id` объединять нельзя: один и тот же `id` (например, `pawn_isolated`)
 * штатно встречается в массиве несколько раз с разными `square`/`color`
 * — это разные пешки/фигуры, и без полного ключа значения затирали бы
 * друг друга.
 *
 * Три ветки слияния (acceptance KS-3699):
 *  - фактор присутствует и в исходной, и в конечной позиции → один
 *    элемент с обоими наборами значений;
 *  - только в исходной → один элемент только с `value_mg`/`value_eg`;
 *  - только в конечной → один элемент только с `terminal_value_mg`/
 *    `terminal_value_eg`.
 *
 * Порядок элементов: сначала те, что были в исходной (в исходном
 * порядке), затем добавленные «только конечные» (в порядке появления
 * в terminal-массиве). Это удобно для логов и снапшотов: исходная
 * позиция важнее.
 */
import { Chess } from 'chess.js';

import type { PositionalSubterm, PositionalSubtermId } from '@kingside/shared';

/**
 * Элемент объединённого массива факторов. Все «value»-поля опциональны:
 * присутствуют только те, что реально есть у этого фактора в одной из
 * позиций.
 */
export interface MergedFactor {
  id: PositionalSubtermId;
  square?: string;
  color?: 'w' | 'b';
  /** Исходное значение в midgame-фазе. */
  value_mg?: number;
  /** Исходное значение в endgame-фазе. */
  value_eg?: number;
  /** Значение в позиции конца pv (midgame). */
  terminal_value_mg?: number;
  /** Значение в позиции конца pv (endgame). */
  terminal_value_eg?: number;
}

/**
 * Составной ключ для объединения. `square`/`color` опциональны — для
 * них используется placeholder `-`, чтобы исключить случайное слипание
 * с фактором, где это поле просто отсутствует.
 */
function keyOf(t: PositionalSubterm): string {
  return `${t.id}|${t.color ?? '-'}|${t.square ?? '-'}`;
}

export function mergeFactors(
  initial: PositionalSubterm[],
  terminal: PositionalSubterm[],
): MergedFactor[] {
  const map = new Map<string, MergedFactor>();
  // Шаг 1: заливаем исходные. Порядок Map сохраняет первое появление.
  for (const t of initial) {
    const k = keyOf(t);
    if (map.has(k)) continue; // дубль по полному ключу — игнорируем
    const entry: MergedFactor = {
      id: t.id,
      value_mg: t.value_mg,
      value_eg: t.value_eg,
    };
    if (t.color !== undefined) entry.color = t.color;
    if (t.square !== undefined) entry.square = t.square;
    map.set(k, entry);
  }
  // Шаг 2: проходимся по terminal. Если такой ключ есть — дописываем
  // terminal-значения. Если нет — добавляем новый элемент только с
  // terminal-значениями.
  for (const t of terminal) {
    const k = keyOf(t);
    const existing = map.get(k);
    if (existing) {
      existing.terminal_value_mg = t.value_mg;
      existing.terminal_value_eg = t.value_eg;
      continue;
    }
    const entry: MergedFactor = {
      id: t.id,
      terminal_value_mg: t.value_mg,
      terminal_value_eg: t.value_eg,
    };
    if (t.color !== undefined) entry.color = t.color;
    if (t.square !== undefined) entry.square = t.square;
    map.set(k, entry);
  }
  return [...map.values()];
}

/**
 * Проигрывает UCI-pv из позиции `fen` и возвращает FEN конца линии.
 *
 * Возвращает `null`, если:
 *  - pv пустой / только пробелы;
 *  - стартовый FEN не валиден;
 *  - встретился ход, который chess.js не принимает (нелегальный, не
 *    UCI, рассинхрон с позицией). В этом случае линия игнорируется
 *    полностью — частично проигранная позиция не использовать
 *    («20 полуходов вперёд» по урезанному варианту даст хуже сигнал,
 *    чем без terminal-факторов вовсе).
 *
 * UCI-формат: `<from><to>[promotion]` — `e2e4`, `e7e8q`.
 */
export function playOutPv(fen: string, pvUci: string): string | null {
  const moves = pvUci.trim().split(/\s+/).filter(Boolean);
  if (moves.length === 0) return null;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  for (const uci of moves) {
    if (uci.length < 4 || uci.length > 5) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci[4] : undefined;
    try {
      const result = chess.move({ from, to, promotion });
      if (!result) return null;
    } catch {
      // chess.js v1.x на нелегальном ходе кидает Error, а не возвращает null.
      return null;
    }
  }
  return chess.fen();
}
