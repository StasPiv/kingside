/**
 * KS-2266 (ADR-037 §1, §6, этап E1) — категории NAG-аннотаций ходов
 * и хелпер `setNagInCategory` для замены NAG внутри одной группы
 * (с поддержкой toggle-off при повторном клике).
 *
 * # Категории
 *
 * Категории взяты из стандарта PGN NAG (subset, поддерживаемый UI):
 *  - `quality`         — оценка качества хода (1..6: `!`, `?`, `!!`, `??`, `!?`, `?!`).
 *  - `positionEval`    — оценка позиции (10–13: `=`/`∞`, 14..19: `⩲`, `⩱`, `±`, `∓`, `+−`, `−+`).
 *
 * NAG `7` (`□` — единственный ход) остался вне категорий — он не
 * требуется для дедупликации (один на ход), и палитра его пока не
 * показывает.
 *
 * # Бизнес-правило (ADR-037 §6)
 *
 * Внутри одной категории у хода может быть **не больше одного** NAG.
 * Поведение `setNagInCategory(nags, newNag)`:
 *   1. Если `newNag` уже стоит в `nags` → toggle-off (удалить).
 *   2. Если в `nags` есть другой NAG из той же категории → заменить.
 *   3. Иначе добавить `newNag`.
 * NAG из других категорий и неизвестные NAG в `nags` сохраняются
 * без изменений.
 *
 * Bug, который чинит этот модуль: ранее `handleNagToggle` в
 * `ReviewMoveList.tsx` просто пушил в массив, и пользователь мог
 * получить `[1, 3]` (`! !!`) или `[3, 5]` (`!! !?`) на одном ходе.
 */

export type NagCategory = 'quality' | 'positionEval';

/** Quality NAGs (subset, ADR-037 §1). */
export const QUALITY_NAGS: readonly number[] = [1, 2, 3, 4, 5, 6];

/**
 * Position-eval NAGs (subset, ADR-037 §1).
 * 10/11/12 — все три формальные «equal chances» по PGN-стандарту
 * (balanced / quiet / active); рендерятся одним символом `=`. NAG 11
 * специально используется `pickFinalEvalNag` в Game Review как маркер
 * равенства в финальной позиции варианта, поэтому без него в
 * категории eval-NAG в дереве вариантов не рендерился.
 *
 * ВНИМАНИЕ: этот массив — для категоризации (nagCategory /
 * groupNagsByCategory), он принимает ЛЮБЫЕ значения из стандарта.
 * Для UI-палитры используется `POSITION_EVAL_NAG_PALETTE` ниже —
 * без дубликатов символа `=`.
 */
export const POSITION_EVAL_NAGS: readonly number[] = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
];

/**
 * Канонический набор кнопок eval-NAG для UI-палитры (NagPalette).
 * Здесь намеренно нет 11/12 — иначе на палитре было бы три одинаковых
 * кнопки «=». Для записи равенства в палитре используется 10 как
 * канонический NAG; 11/12 распознаются при чтении PGN и рендере.
 */
export const POSITION_EVAL_NAG_PALETTE: readonly number[] = [
  10, 13, 14, 15, 16, 17, 18, 19,
];

/**
 * Категория NAG. `null` — NAG вне поддерживаемых категорий
 * (например, `7 □` или произвольный `$42`); в `setNagInCategory`
 * такие NAG ведут себя как обычный toggle (add/remove одиночного
 * элемента) без замены.
 */
export function nagCategory(nag: number): NagCategory | null {
  if (QUALITY_NAGS.includes(nag)) return 'quality';
  if (POSITION_EVAL_NAGS.includes(nag)) return 'positionEval';
  return null;
}

/**
 * Применить `newNag` к набору `nags` по категорийной семантике
 * (ADR-037 §6 / KS-2266).
 *
 * @returns новый массив (исходный не мутируется). Порядок остальных
 *          NAG сохраняется; новый NAG (если добавляется) идёт в конец.
 */
export function setNagInCategory(
  nags: readonly number[],
  newNag: number,
): number[] {
  // 1. Toggle-off: повторный клик по тому же NAG снимает его.
  if (nags.includes(newNag)) {
    return nags.filter((n) => n !== newNag);
  }

  const cat = nagCategory(newNag);
  // 2. NAG вне поддерживаемых категорий — простое добавление.
  if (cat === null) {
    return [...nags, newNag];
  }

  // 3. Replace-in-group: убираем все NAG той же категории, добавляем newNag.
  const withoutSameCategory = nags.filter((n) => nagCategory(n) !== cat);
  return [...withoutSameCategory, newNag];
}

/**
 * Группировка NAG по категориям — для рендера «по одному из каждой
 * категории» (см. `renderNagSymbols` в ReviewMoveList).
 *
 * @returns map: категория → последний (наиболее свежий) NAG этой
 *          категории в исходном массиве. Если категория отсутствует
 *          в `nags`, ключа в map'е не будет.
 */
export function groupNagsByCategory(
  nags: readonly number[],
): Partial<Record<NagCategory, number>> {
  const result: Partial<Record<NagCategory, number>> = {};
  for (const nag of nags) {
    const cat = nagCategory(nag);
    if (cat !== null) {
      // последний выигрывает — соответствует replace-семантике setNagInCategory
      result[cat] = nag;
    }
  }
  return result;
}
