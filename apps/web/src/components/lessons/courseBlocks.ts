import type { CourseLessonSummary } from '@kingside/shared';

/**
 * Группировка уроков курса по «блокам».
 *
 * Блок урока приходит с бэка в поле `CourseLessonSummary.blockKey`
 * (см. `packages/shared/src/types/lessons.ts`). Фронт читает это
 * поле и раскладывает уроки по блокам — каждый уникальный `blockKey`
 * становится отдельной секцией на странице курса.
 *
 * # Расширяемость (KS-2036)
 *
 * Раньше `BlockKey` был жёстким type union'ом, а уроки с blockKey'ом
 * не из этого списка падали в служебный блок `'other'` — поэтому
 * новые блоки на бэке (например, `pawn-endgames`, `basic-endgames`
 * во множественном числе) не попадали в свои секции, а сваливались в
 * «Прочее». Теперь:
 *
 *  - `blockKey` — обычная строка, без union'а;
 *  - `BLOCK_ORDER` — список «известных» блоков для УПОРЯДОЧИВАНИЯ:
 *    они идут в этом порядке. Неизвестные блоки рендерятся ПОСЛЕ
 *    известных — в порядке первого появления в массиве уроков (т.е.
 *    стабильно по приходу с API). `'other'` (пустой/null blockKey)
 *    идёт в самом конце;
 *  - заголовок секции — i18n-ключ `lessons.block.<key>` (если в
 *    локали нет — fallback на сам `blockKey`).
 *
 * Чтобы добавить новый блок:
 *  1. БД/seed: указать `blockKey` у урока — секция появится
 *     автоматически (заголовок будет = `blockKey`).
 *  2. Опционально, для красивого заголовка — добавить ключи
 *     `lessons.block.<key>` в `apps/web/src/i18n/locales/{ru,en}/translation.json`.
 *  3. Опционально, чтобы блок встал на нужное место в порядке —
 *     добавить его slug в `BLOCK_ORDER` ниже.
 */

/** Special bucket для уроков без blockKey. Рендерится последним. */
export const OTHER_BLOCK_KEY = 'other';

/**
 * Префиксированный порядок известных блоков. Любой `blockKey`, не
 * перечисленный здесь, попадёт в свою отдельную секцию ПОСЛЕ
 * известных (но до `'other'`).
 */
export const BLOCK_ORDER: string[] = [
  'rules',
  'basic-mates',
  'piece-values',
  'openings',
  'tactics',
  'basic-endgames',
  'pawn-endgames',
  OTHER_BLOCK_KEY,
];

/**
 * Возвращает blockKey урока. Пустой/отсутствующий → `'other'`.
 * Любой непустой `blockKey` возвращается как есть — он автоматически
 * получит свою секцию (см. `groupLessonsByBlock`).
 */
export function getBlockKey(lesson: CourseLessonSummary): string {
  const apiBlock = lesson.blockKey;
  if (typeof apiBlock === 'string' && apiBlock.length > 0) return apiBlock;
  return OTHER_BLOCK_KEY;
}

export interface LessonBlock {
  key: string;
  lessons: CourseLessonSummary[];
}

/**
 * Группирует уроки по `blockKey`. Порядок секций:
 *  1. Блоки из `BLOCK_ORDER` в указанном порядке (но кроме `'other'`).
 *  2. Прочие известные блоки в порядке первого появления в `lessons`.
 *  3. `'other'` — последним.
 *
 * Пустые блоки опускаются. Внутри блока уроки сортируются по `order`.
 */
export function groupLessonsByBlock(
  lessons: CourseLessonSummary[],
): LessonBlock[] {
  const map = new Map<string, CourseLessonSummary[]>();
  // Стабильный порядок встречи неизвестных блоков — отдельный список,
  // чтобы не зависеть от порядка обхода Map (он хоть и стабильный по
  // ES2015, но мы хотим явно).
  const seenOrder: string[] = [];
  for (const l of lessons) {
    const k = getBlockKey(l);
    const arr = map.get(k);
    if (arr) arr.push(l);
    else {
      map.set(k, [l]);
      seenOrder.push(k);
    }
  }

  const known = BLOCK_ORDER.filter((k) => k !== OTHER_BLOCK_KEY);
  const knownSet = new Set(known);
  const unknown = seenOrder.filter(
    (k) => !knownSet.has(k) && k !== OTHER_BLOCK_KEY,
  );
  const finalOrder: string[] = [...known, ...unknown, OTHER_BLOCK_KEY];

  const out: LessonBlock[] = [];
  for (const k of finalOrder) {
    const arr = map.get(k);
    if (arr && arr.length > 0) {
      out.push({ key: k, lessons: [...arr].sort((a, b) => a.order - b.order) });
    }
  }
  return out;
}
