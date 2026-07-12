/**
 * KS-4911 / ADR-162 (решение architect, /tmp/KS-4909-templates-details.md):
 * границы полок и правила выбора — КОНСТАНТЫ КОДА (это логика выбора,
 * а не контент; файлов данных и таблиц не требует). Значения перенесены
 * из tools/study-plan/rating-shelves.json (KS-4885), файлы удалены.
 *
 * Контент шаблонов уроков — скрытые системные курсы
 * `study-template-<shelf>` в существующем lessons-стеке
 * (см. study-template-seeder.service.ts).
 */

export interface RatingShelf {
  key: string;
  minRating: number;
  /** null — без верхней границы. */
  maxRating: number | null;
  /** Системный курс полки для блока «следующий урок» профиля v1. */
  courseSlug: string;
  /** Темы пазлов, когда у ученика нет статистики слабых тем. */
  priorityThemes: string[];
  /** Ротация практических homework-задач. */
  practiceRotation: string[];
}

/**
 * Glicko-калибровка: deviation выше порога → рейтинг не показателен,
 * берём стартовую полку.
 */
export const RATING_DEVIATION_THRESHOLD = 150;
export const FALLBACK_SHELF_KEY = 'beginner';

export const RATING_SHELVES: RatingShelf[] = [
  {
    key: 'novice',
    minRating: 0,
    maxRating: 1200,
    courseSlug: 'capablanca-primer',
    priorityThemes: ['mateIn1', 'hangingPiece', 'oneMove', 'fork', 'backRankMate', 'mateIn2'],
    practiceRotation: ['mistakes', 'drill', 'puzzle_rush'],
  },
  {
    key: 'beginner',
    minRating: 1200,
    maxRating: 1500,
    courseSlug: 'capablanca-primer',
    priorityThemes: ['fork', 'pin', 'skewer', 'hangingPiece', 'mateIn2', 'discoveredAttack'],
    practiceRotation: ['mistakes', 'drill', 'puzzle_rush', 'rated_game'],
  },
  {
    key: 'intermediate',
    minRating: 1500,
    maxRating: 1800,
    courseSlug: 'capablanca-fundamentals',
    priorityThemes: ['deflection', 'attraction', 'trappedPiece', 'mateIn3', 'sacrifice', 'intermezzo'],
    practiceRotation: ['mistakes', 'precision', 'drill', 'rated_game', 'game_review', 'puzzle_rush'],
  },
  {
    key: 'advanced',
    minRating: 1800,
    maxRating: 2100,
    courseSlug: 'dvoretsky-endgame-manual',
    priorityThemes: ['quietMove', 'clearance', 'interference', 'xRayAttack', 'capturingDefender', 'endgame'],
    practiceRotation: ['mistakes', 'precision', 'rated_game', 'game_review', 'drill', 'puzzle_rush'],
  },
  {
    key: 'club_strong',
    minRating: 2100,
    maxRating: null,
    courseSlug: 'dvoretsky-endgame-manual',
    priorityThemes: ['quietMove', 'zugzwang', 'defensiveMove', 'underPromotion', 'mateIn4', 'veryLong'],
    practiceRotation: ['precision', 'rated_game', 'game_review', 'mistakes', 'drill', 'puzzle_rush'],
  },
];

/** Focus-оверрайды расписания (StudySchedule.focus). */
const FOCUS_OVERRIDES: Record<
  string,
  { courseSlug?: string; priorityThemesPrepend?: string[]; practiceRotationPrepend?: string[] }
> = {
  tactics: {
    priorityThemesPrepend: ['fork', 'pin', 'discoveredAttack', 'deflection', 'attraction'],
  },
  openings: {
    practiceRotationPrepend: ['drill'],
    priorityThemesPrepend: ['opening'],
  },
  endgames: {
    courseSlug: 'dvoretsky-endgame-manual',
    priorityThemesPrepend: ['pawnEndgame', 'rookEndgame', 'queenEndgame', 'knightEndgame', 'bishopEndgame', 'endgame'],
  },
  balanced: {},
};

/** Полка по рейтингу с учётом Glicko-калибровки. */
export function shelfFor(ratingPuzzle: number, ratingPuzzleDev: number): RatingShelf {
  if (ratingPuzzleDev > RATING_DEVIATION_THRESHOLD) {
    const fb = RATING_SHELVES.find((s) => s.key === FALLBACK_SHELF_KEY);
    if (fb) return fb;
  }
  return (
    RATING_SHELVES.find(
      (s) =>
        ratingPuzzle >= s.minRating &&
        (s.maxRating === null || ratingPuzzle < s.maxRating),
    ) ?? RATING_SHELVES[0]
  );
}

/** Полка с применённым focus-оверрайдом. */
export function shelfWithFocus(
  ratingPuzzle: number,
  ratingPuzzleDev: number,
  focus: string | null,
): RatingShelf {
  const base = shelfFor(ratingPuzzle, ratingPuzzleDev);
  const override = focus ? FOCUS_OVERRIDES[focus] : undefined;
  if (!override) return base;
  return {
    ...base,
    courseSlug: override.courseSlug ?? base.courseSlug,
    priorityThemes: [...(override.priorityThemesPrepend ?? []), ...base.priorityThemes],
    practiceRotation: [...(override.practiceRotationPrepend ?? []), ...base.practiceRotation],
  };
}

/** Slug скрытого системного курса-шаблона полки. */
export function templateSlugFor(shelfKey: string): string {
  return `study-template-${shelfKey}`;
}

/** Подстановка {{name}} (контракт плейсхолдеров шаблонов, KS-4910/4911). */
export function fillPlaceholders(
  template: string,
  args: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) =>
    name in args ? String(args[name]) : m,
  );
}
