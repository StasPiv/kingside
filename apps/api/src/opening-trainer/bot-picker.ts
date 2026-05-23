import type { RepertoireEdge, OpeningTrainerRepeatMode } from '@kingside/shared';

/**
 * KS-3272 (ADR-077 §2.3). Random-without-repeat picker для бот-хода
 * в Opening Trainer'е.
 *
 * Логика:
 *   1. Берём `edges` из текущей позиции, фильтруем те, которые уже
 *      сыграны в этой сессии (`playedChildFens`).
 *   2. Если непусто — uniform-random выбор.
 *   3. Если все edges пройдены:
 *        - `repeatMode='cycle'`    → сбрасываем played, выбираем заново.
 *        - `repeatMode='complete'` → возвращаем lineComplete=true.
 *   4. Если `edges` пуст изначально (конец заученной линии) — возвращаем
 *      lineComplete=true.
 *
 * Чистая функция: не работает с Redis/DB, не дёргает chess.js. Тестируется
 * детерминированно через подменяемый `random()`. Caller отвечает за
 * персистенс `playedChildFens` (в `session.playedLines[currentFen]`).
 */

export interface BotPickInput {
  /** Все edges из текущей позиции (см. `RepertoireTree.nodes[fen].edges`). */
  edges: RepertoireEdge[];
  /** `childFen`'ы, которые бот уже сыграл из этой позиции в данной сессии. */
  playedChildFens: ReadonlyArray<string>;
  repeatMode: OpeningTrainerRepeatMode;
  /** Источник случайности (для тестов). Default `Math.random`. */
  random?: () => number;
}

export interface BotPickResult {
  /** Выбранный edge или null, если линия завершена. */
  pick: RepertoireEdge | null;
  /**
   * `true` если cycle-mode сработал и список played'ов был обнулён.
   * Caller должен заменить `playedLines[currentFen] = [pick.childFen]`.
   */
  cycled: boolean;
  /**
   * `true` если возвращать нечего: либо `edges` был пуст изначально
   * (конец линии), либо `repeatMode='complete'` и все пройдены.
   */
  lineComplete: boolean;
}

/**
 * Возвращает следующий бот-ход согласно random-without-repeat алгоритму
 * (ADR-077 §2.3).
 */
export function pickBotMove(input: BotPickInput): BotPickResult {
  const { edges, playedChildFens, repeatMode } = input;
  const random = input.random ?? Math.random;

  if (edges.length === 0) {
    return { pick: null, cycled: false, lineComplete: true };
  }

  const playedSet = new Set(playedChildFens);
  const available = edges.filter((e) => !playedSet.has(e.childFen));

  if (available.length > 0) {
    return {
      pick: pickUniform(available, random),
      cycled: false,
      lineComplete: false,
    };
  }

  // Все edges пройдены.
  if (repeatMode === 'cycle') {
    return {
      pick: pickUniform(edges, random),
      cycled: true,
      lineComplete: false,
    };
  }

  // repeatMode === 'complete'
  return { pick: null, cycled: false, lineComplete: true };
}

function pickUniform<T>(arr: ReadonlyArray<T>, random: () => number): T {
  // Защитный assert: при пустом arr ошибка лучше «вернули undefined».
  if (arr.length === 0) {
    throw new Error('pickUniform: empty array');
  }
  const idx = Math.floor(random() * arr.length);
  // Защита от random()===1 (теоретически не бывает, но JS).
  const safeIdx = Math.min(idx, arr.length - 1);
  return arr[safeIdx];
}
