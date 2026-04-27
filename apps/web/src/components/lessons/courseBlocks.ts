import type { CourseLessonSummary } from '@kingside/shared';

/**
 * Группировка уроков курса по «блокам».
 *
 * Блок урока приходит с бэка в поле `CourseLessonSummary.blockKey`,
 * порядок блоков курса — в `Course.blockOrder` (`packages/shared/
 * src/types/lessons.ts`). Фронт раскладывает уроки по блокам и
 * упорядочивает секции согласно `blockOrder` курса.
 *
 * # KS-2038: порядок из API
 *
 * Раньше `BLOCK_ORDER` был хардкод-массивом на фронте, и любой новый
 * курс с другим методическим планом требовал правки кода. После
 * KS-2037 backend хранит и отдаёт `Course.blockOrder: string[]` —
 * фронт его подставляет напрямую. Хардкод убран.
 *
 *  - blockKey'и из `blockOrder` рендерятся в этом порядке;
 *  - blockKey'и не из `blockOrder` рендерятся ПОСЛЕ — в порядке
 *    первого появления в `lessons` (стабильный API order);
 *  - `'other'` (пустой/null blockKey у урока) — последним;
 *  - `blockOrder = []` (или не передан) → порядок «как пришло из
 *    API» (по первому появлению), `'other'` всё равно в конце.
 *
 * Заголовок секции — i18n-ключ `lessons.block.<key>` (если в локали
 * нет — fallback на сам `blockKey`); отображение в JSX берёт
 * `t(\`lessons.block.${block.key}\`, block.key)` в `CoursePage`.
 */

/** Special bucket для уроков без blockKey. Рендерится последним. */
export const OTHER_BLOCK_KEY = 'other';

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
 * Группирует уроки по `blockKey` и упорядочивает секции согласно
 * `blockOrder` курса (`Course.blockOrder` из API).
 *
 * Порядок секций:
 *  1. blockKey'и из `blockOrder` в указанном порядке (без `'other'`).
 *  2. blockKey'и НЕ из `blockOrder` — в порядке первого появления
 *     в `lessons` (стабильный API order).
 *  3. `'other'` — последним.
 *
 * Пустые блоки опускаются. Внутри блока уроки сортируются по `order`.
 *
 * @param lessons     Список уроков курса.
 * @param blockOrder  Упорядоченный список `blockKey` (из `Course.blockOrder`).
 *                    Если пустой/не передан — всё определяется порядком
 *                    появления в `lessons`.
 */
export function groupLessonsByBlock(
  lessons: CourseLessonSummary[],
  blockOrder: readonly string[] = [],
): LessonBlock[] {
  const map = new Map<string, CourseLessonSummary[]>();
  // Стабильный порядок встречи блоков — отдельный список, чтобы не
  // зависеть от порядка обхода Map (он хоть и стабильный по ES2015,
  // но мы хотим явно фиксировать «первое появление в lessons»).
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

  const ordered = blockOrder.filter((k) => k !== OTHER_BLOCK_KEY);
  const orderedSet = new Set(ordered);
  const trailing = seenOrder.filter(
    (k) => !orderedSet.has(k) && k !== OTHER_BLOCK_KEY,
  );
  const finalOrder: string[] = [...ordered, ...trailing, OTHER_BLOCK_KEY];

  const out: LessonBlock[] = [];
  for (const k of finalOrder) {
    const arr = map.get(k);
    if (arr && arr.length > 0) {
      out.push({ key: k, lessons: [...arr].sort((a, b) => a.order - b.order) });
    }
  }
  return out;
}
