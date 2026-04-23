import type { CourseFixture } from '../../fixture-types';
import { block01Rules } from './blocks/01-rules';
import { block02BasicMates } from './blocks/02-basic-mates';
import { block03PieceValues } from './blocks/03-piece-values';
import { block04Openings } from './blocks/04-openings';
import { block05Tactics } from './blocks/05-tactics';
import { block06BasicEndgame } from './blocks/06-basic-endgame';

/**
 * Курс «Начинающий» (L-14a / L-14b, KS-1769 / KS-1773).
 *
 * 6 блоков, 30 уроков. Контент получен от chess-expert
 * (`/tmp/lessons-beginner/*.md`) и упакован по формату L-05.
 *
 * Pуccкий текст — в `apps/api/src/i18n/ru/lessons.json`.
 * Английские переводы — после L-16 (roadmap §5).
 */
export const beginnerCourse: CourseFixture = {
  slug: 'beginner',
  level: 'beginner',
  titleKey: 'lessons.beginner.title',
  descriptionKey: 'lessons.beginner.description',
  order: 0,
  isPublished: true,
  lessons: [
    ...block01Rules,
    ...block02BasicMates,
    ...block03PieceValues,
    ...block04Openings,
    ...block05Tactics,
    ...block06BasicEndgame,
  ],
};
