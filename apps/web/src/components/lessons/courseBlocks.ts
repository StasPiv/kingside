import type { CourseLessonSummary } from '@kingside/shared';

/**
 * Группировка уроков курса по «блокам».
 *
 * Блок урока приходит с бэка в поле `CourseLessonSummary.blockKey`
 * (см. `packages/shared/src/types/lessons.ts`). Фронт только читает
 * это поле и раскладывает уроки в порядке `BLOCK_ORDER`. Если у урока
 * `blockKey` не совпадает ни с одним известным блоком — он попадает в
 * служебный блок `'other'`, который рендерится последним.
 */

export type BlockKey =
  | 'rules'
  | 'basic-mates'
  | 'piece-values'
  | 'openings'
  | 'tactics'
  | 'basic-endgame'
  | 'other';

/** Порядок блоков на странице. */
export const BLOCK_ORDER: BlockKey[] = [
  'rules',
  'basic-mates',
  'piece-values',
  'openings',
  'tactics',
  'basic-endgame',
  'other',
];

/**
 * Возвращает blockKey для урока. Читает `lesson.blockKey` с бэка,
 * если значение не из списка известных блоков — возвращает `'other'`.
 */
export function getBlockKey(lesson: CourseLessonSummary): BlockKey {
  const apiBlock = lesson.blockKey;
  if (apiBlock && (BLOCK_ORDER as string[]).includes(apiBlock)) {
    return apiBlock as BlockKey;
  }
  return 'other';
}

export interface LessonBlock {
  key: BlockKey;
  lessons: CourseLessonSummary[];
}

/**
 * Группирует уроки по `blockKey`. Возвращает блоки в `BLOCK_ORDER`,
 * пустые блоки опускает. Внутри блока уроки идут по `order`.
 */
export function groupLessonsByBlock(
  lessons: CourseLessonSummary[],
): LessonBlock[] {
  const map = new Map<BlockKey, CourseLessonSummary[]>();
  for (const l of lessons) {
    const k = getBlockKey(l);
    const arr = map.get(k);
    if (arr) arr.push(l);
    else map.set(k, [l]);
  }
  const out: LessonBlock[] = [];
  for (const k of BLOCK_ORDER) {
    const arr = map.get(k);
    if (arr && arr.length > 0) {
      out.push({ key: k, lessons: [...arr].sort((a, b) => a.order - b.order) });
    }
  }
  return out;
}
