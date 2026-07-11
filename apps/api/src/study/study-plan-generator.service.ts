import { Injectable } from '@nestjs/common';

/**
 * KS-4881 / ADR-160 §2. Детерминированная таблица правил сборки
 * занятия — чистая логика без I/O (unit-тестируется напрямую).
 *
 * Занятие = 2–4 блока по бюджету времени (`sessionMinutes`):
 *   1. SM-2 повторение — до 2 просроченных LessonReview (если есть due)
 *   2. Тактика по слабой теме — 8–12 пазлов, окно рейтинга с адаптацией
 *   3. Теория — следующий урок активного курса (estMinutes ≤ остаток)
 *   4. Практика — ротация: mistakes → precision → drill →
 *      rated_game(+game_review) → puzzle_rush
 *
 * Адаптация (§2.3):
 *   - сложность: решаемость тематических пазлов за последние 3 занятия
 *     < 40 % → окно −100; > 80 % → +50
 *   - объём: < 50 % задач в двух занятиях подряд → максимум 2 блока;
 *     3 полных подряд → разрешён 4-й блок (иначе 3)
 *   - перенос: незакрытые SM-2 и тема expired-занятия приоритетнее
 */

/** Типы заданий (ADR-160 §3, StudyTask.type). */
export type StudyTaskType =
  | 'puzzle_theme'
  | 'sm2_review'
  | 'lesson'
  | 'mistakes'
  | 'precision'
  | 'drill'
  | 'rated_game'
  | 'game_review'
  | 'puzzle_rush'
  | 'external_games';

/** Порядок ротации практики (§2.2, блок 4). */
export const PRACTICE_ROTATION: StudyTaskType[] = [
  'mistakes',
  'precision',
  'drill',
  'rated_game',
  'puzzle_rush',
];

/** Оценки стоимости блоков в минутах (детерминированные константы). */
export const BLOCK_MINUTES = {
  sm2PerReview: 5,
  puzzlePerItem: 1.5,
  mistakes: 10,
  precision: 10,
  drill: 10,
  ratedGame: 20, // партия + короткий разбор
  puzzleRush: 5,
} as const;

/** Профиль ученика — входы генератора (§2.1), собирает StudyProfileService. */
export interface StudyProfile {
  ratingPuzzle: number;
  /** Просроченные SM-2 повторения: lessonId по возрастанию dueAt. */
  dueReviewLessonIds: string[];
  /**
   * Слабые темы за 30 дней: attempted ≥ 10 и rate < 65, по возрастанию
   * rate (первая — худшая). rate в процентах 0-100.
   */
  weakThemes: Array<{ theme: string; attempted: number; rate: number }>;
  /** Следующий урок активного курса (или системного по полке). */
  nextLesson: {
    lessonId: string;
    courseId: string;
    /** Slug курса — для deep-link `/lessons/:slug/:lessonId` в уведомлении. */
    courseSlug: string;
    estMinutes: number;
  } | null;
  /** Решаемость тематических пазлов за последние 3 занятия (%, null = мало данных). */
  recentThemeSolveRate: number | null;
  /** Доля выполненных задач в каждом из последних занятий, новые первыми (0-1). */
  recentCompletionRates: number[];
  /** Момент последнего использования каждого типа практики (нет = никогда). */
  practiceLastUsedAt: Partial<Record<StudyTaskType, Date>>;
  /** Перенос из последнего expired-занятия (§2.3): не более одного занятия «долга». */
  carryOver: { sm2LessonIds: string[]; theme: string | null };
}

/** План-задание (до записи в БД). */
export interface PlannedTask {
  type: StudyTaskType;
  params: Record<string, unknown>;
  targetCount: number;
}

@Injectable()
export class StudyPlanGeneratorService {
  /**
   * Сборка занятия по таблице правил. Детерминирована: одинаковые
   * входы → одинаковый план.
   */
  buildPlan(profile: StudyProfile, sessionMinutes: number): PlannedTask[] {
    const tasks: PlannedTask[] = [];
    let budget = sessionMinutes;
    const maxBlocks = this.maxBlocks(profile);
    let blocks = 0;

    // ── Блок 1: SM-2 (приоритет 1, если есть due) ──
    const sm2Ids = [
      ...profile.carryOver.sm2LessonIds,
      ...profile.dueReviewLessonIds.filter(
        (id) => !profile.carryOver.sm2LessonIds.includes(id),
      ),
    ].slice(0, 2);
    if (sm2Ids.length > 0 && blocks < maxBlocks) {
      const cost = sm2Ids.length * BLOCK_MINUTES.sm2PerReview;
      tasks.push({
        type: 'sm2_review',
        params: { lessonIds: sm2Ids },
        targetCount: sm2Ids.length,
      });
      budget -= cost;
      blocks++;
    }

    // ── Блок 2: тактика по слабой теме (всегда) ──
    if (blocks < maxBlocks) {
      const theme = profile.carryOver.theme ?? profile.weakThemes[0]?.theme ?? null;
      const count = this.puzzleCount(budget);
      const window = this.ratingWindow(profile);
      tasks.push({
        type: 'puzzle_theme',
        params: {
          theme,
          ratingMin: profile.ratingPuzzle + window.min,
          ratingMax: profile.ratingPuzzle + window.max,
        },
        targetCount: count,
      });
      budget -= count * BLOCK_MINUTES.puzzlePerItem;
      blocks++;
    }

    // ── Блок 3: следующий урок курса (если влезает в остаток) ──
    if (
      blocks < maxBlocks &&
      profile.nextLesson &&
      profile.nextLesson.estMinutes <= budget
    ) {
      tasks.push({
        type: 'lesson',
        params: {
          lessonId: profile.nextLesson.lessonId,
          courseId: profile.nextLesson.courseId,
          courseSlug: profile.nextLesson.courseSlug,
        },
        targetCount: 1,
      });
      budget -= profile.nextLesson.estMinutes;
      blocks++;
    }

    // ── Блок 4: практика ротацией (тип, не использованный дольше всех) ──
    if (blocks < maxBlocks) {
      const practice = this.pickPractice(profile);
      if (this.practiceCost(practice) <= budget) {
        tasks.push(...this.practiceTasks(practice));
      }
    }

    return tasks;
  }

  /** §2.3 объём: reduced → 2 блока, expanded → 4, иначе 3. */
  maxBlocks(profile: StudyProfile): number {
    const r = profile.recentCompletionRates;
    if (r.length >= 2 && r[0] < 0.5 && r[1] < 0.5) return 2;
    if (r.length >= 3 && r[0] >= 1 && r[1] >= 1 && r[2] >= 1) return 4;
    return 3;
  }

  /**
   * §2.2/§2.3 окно рейтинга пазлов: базово −100…+50; решаемость < 40 %
   * → смещение вниз на 100; > 80 % → вверх на 50.
   */
  ratingWindow(profile: StudyProfile): { min: number; max: number } {
    const rate = profile.recentThemeSolveRate;
    if (rate !== null && rate < 40) return { min: -200, max: -50 };
    if (rate !== null && rate > 80) return { min: -50, max: 100 };
    return { min: -100, max: 50 };
  }

  /** 8–12 пазлов по остатку бюджета (≈40 % остатка, 1.5 мин/пазл). */
  puzzleCount(budgetMinutes: number): number {
    const byBudget = Math.floor((budgetMinutes * 0.4) / BLOCK_MINUTES.puzzlePerItem);
    return Math.max(8, Math.min(12, byBudget));
  }

  /** Ротация практики: тип с самым старым (или отсутствующим) использованием. */
  pickPractice(profile: StudyProfile): StudyTaskType {
    let best: StudyTaskType = PRACTICE_ROTATION[0];
    let bestTime = Infinity;
    for (const type of PRACTICE_ROTATION) {
      const used = profile.practiceLastUsedAt[type];
      const t = used ? used.getTime() : -1; // никогда = самый старый
      if (t < bestTime) {
        bestTime = t;
        best = type;
      }
    }
    return best;
  }

  practiceCost(type: StudyTaskType): number {
    switch (type) {
      case 'mistakes':
        return BLOCK_MINUTES.mistakes;
      case 'precision':
        return BLOCK_MINUTES.precision;
      case 'drill':
        return BLOCK_MINUTES.drill;
      case 'rated_game':
        return BLOCK_MINUTES.ratedGame;
      default:
        return BLOCK_MINUTES.puzzleRush;
    }
  }

  /** rated_game — один блок из двух задач (партия + разбор, §2.2). */
  private practiceTasks(type: StudyTaskType): PlannedTask[] {
    switch (type) {
      case 'mistakes':
        return [{ type, params: {}, targetCount: 8 }];
      case 'precision':
        return [{ type, params: {}, targetCount: 3 }];
      case 'drill':
        return [{ type, params: {}, targetCount: 10 }];
      case 'rated_game':
        return [
          { type: 'rated_game', params: {}, targetCount: 1 },
          { type: 'game_review', params: {}, targetCount: 1 },
        ];
      default:
        return [{ type: 'puzzle_rush', params: { timeMode: '5m' }, targetCount: 1 }];
    }
  }
}
