import type { CourseLessonSummary } from '@kingside/shared';

/**
 * Группировка уроков по «блокам» курса (KS-1785, QA bug).
 *
 * QA-spec для курса beginner — 6 блоков:
 *   rules / basic-mates / piece-values / openings / tactics / basic-endgame
 *
 * Backend-API (`CourseLessonSummary`) пока **не возвращает** `blockKey`
 * (см. `packages/shared/src/types/lessons.ts`). Прошу backend задачу на
 * добавление поля; пока что — fallback по slug-mapping для уроков
 * курса beginner. Если в `lesson` появится поле `blockKey` (через
 * расширение типа), `getBlockKey` будет использовать его автоматически.
 *
 * Уроки, slug которых не найден в маппинге, попадают в служебный блок
 * `'other'` — он рендерится последним, чтобы новые seed-уроки не
 * терялись из UI.
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

/** Маппинг slug → blockKey для курса beginner (KS-1785 fallback). */
const SLUG_TO_BLOCK: Record<string, BlockKey> = {
  // rules
  'board-coordinates': 'rules',
  'pawn-moves': 'rules',
  'knight-moves': 'rules',
  'bishop-moves': 'rules',
  'rook-moves': 'rules',
  'queen-moves': 'rules',
  'king-and-castling': 'rules',
  'check-mate-draw': 'rules',
  // basic-mates
  'mate-queen-king': 'basic-mates',
  'mate-rook-king': 'basic-mates',
  'mate-two-rooks': 'basic-mates',
  'mate-patterns-recognition': 'basic-mates',
  // piece-values
  'piece-values': 'piece-values',
  exchanges: 'piece-values',
  'hanging-pieces': 'piece-values',
  // openings
  'opening-principles': 'openings',
  'center-control': 'openings',
  'piece-development': 'openings',
  'castling-when': 'openings',
  'opening-mistakes': 'openings',
  // tactics
  fork: 'tactics',
  pin: 'tactics',
  'double-attack': 'tactics',
  'discovered-attack': 'tactics',
  'discovered-check': 'tactics',
  'mate-in-one-two': 'tactics',
  // basic-endgame
  'king-pawn-vs-king': 'basic-endgame',
  'pawn-promotion': 'basic-endgame',
  'active-king-endgame': 'basic-endgame',
  'stalemate-tricks': 'basic-endgame',
};

/**
 * Возвращает blockKey для урока. Сначала смотрит API-поле `blockKey`
 * (после backend-апдейта), затем slug-fallback, затем `'other'`.
 */
export function getBlockKey(lesson: CourseLessonSummary): BlockKey {
  const apiBlock = (lesson as unknown as { blockKey?: string }).blockKey;
  if (apiBlock && BLOCK_ORDER.includes(apiBlock as BlockKey)) {
    return apiBlock as BlockKey;
  }
  return SLUG_TO_BLOCK[lesson.slug] ?? 'other';
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
