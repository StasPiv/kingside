import type { StudyProfile } from '../study-plan-generator.service';

/**
 * KS-4910 / ADR-162 §4. Контракт «партии → материал урока».
 * Будущая продуктовая логика (поиск типичных ошибок) — вторая
 * реализация этого интерфейса без перестройки занятий. Серверного
 * движка нет и не будет (инвариант KS-2433) — extract() работает
 * только по данным БД и PGN-заголовкам.
 */
export interface LessonMaterialSource {
  extract(userId: string, profile: StudyProfile): Promise<LessonMaterial>;
}

export interface LessonMaterial {
  /** Темы, на которых строится урок (худшие/приоритетные первыми). */
  focusThemes: string[];
  /** Партии пользователя для game-шагов «пройди свою партию». */
  gameFragments: GameFragment[];
  /** Позиции для custom-puzzle шага (baseline: пусто, ADR-162 §4). */
  positions: CustomPuzzleMaterial[];
  /** Наблюдения для вводного text-шага. */
  notes: MaterialNote[];
}

export interface GameFragment {
  /** Полный PGN партии (snapshot для GameStepPayload sourceType='pgn'). */
  pgn: string;
  white: string | null;
  black: string | null;
  result: string | null;
  /** Название дебюта (тег Opening / ECO). */
  opening: string | null;
}

/** Минимум для PuzzleStepSelection mode='custom' (fen + solutionMoves). */
export interface CustomPuzzleMaterial {
  fen: string;
  solutionMoves: string[];
}

/**
 * Наблюдение — ключ строки noteLines шаблона + аргументы подстановки
 * (lesson-templates.<lang>.json, схема KS-4910).
 */
export interface MaterialNote {
  key: 'results' | 'openings' | 'colors' | 'carryOver' | 'noGames';
  args: Record<string, string | number>;
}
