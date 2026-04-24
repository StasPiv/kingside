import { Injectable } from '@nestjs/common';
import type {
  CourseLevel,
  LevelGateBlocker,
  LevelGateResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * L-15 (KS-1770) + L-26 (KS-1804): критерий перехода между уровнями курсов.
 * Источник правил — ADR-024 §2.3 и методическое видение KS-1754.
 *
 * Переходы:
 *  - Beginner → Intermediate:
 *    - курс `beginner` завершён (все `isPublished=true` уроки имеют
 *      `UserLessonProgress.completedAt != null`);
 *    - `user.ratingPuzzle >= 1200`;
 *    - суммарно `gamesPlayedRapid + gamesPlayedBlitz + gamesPlayedClassical >= 20`
 *      (bullet не учитываем — договорённость в KS-1770).
 *
 *  - Intermediate → Advanced (L-26, KS-1804):
 *    - курс `intermediate` завершён (все `isPublished=true` уроки);
 *    - `user.ratingPuzzle >= 1700`;
 *    - `user.ratingRapid >= 1400`;
 *    - решено ≥ 500 задач (`PuzzleAttempt.solved = true`).
 *
 *  - Advanced — терминальный уровень: `nextLevel=null, unlocked=true`.
 *
 * Endpoint `/api/lessons/level-gate` принимает опциональный `?from=<level>`:
 *  - если передан — возвращает гейт с этого уровня;
 *  - если не передан — сервер выбирает текущий уровень пользователя
 *    (первый уровень, чей gate не `unlocked`; если все закрыты → `advanced`).
 */
type CurrentUserForGate = {
  ratingPuzzle: number;
  ratingRapid: number;
  gamesPlayedRapid: number;
  gamesPlayedBlitz: number;
  gamesPlayedClassical: number;
};

@Injectable()
export class LevelGateService {
  private readonly BEGINNER_TO_INTERMEDIATE = {
    courseSlug: 'beginner',
    minPuzzleRating: 1200,
    minGamesPlayed: 20,
  };

  private readonly INTERMEDIATE_TO_ADVANCED = {
    courseSlug: 'intermediate',
    minPuzzleRating: 1700,
    minRapidRating: 1400,
    minPuzzlesSolved: 500,
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param userId        — кто запрашивает статус.
   * @param fromLevel     — (опц.) явный уровень, для которого вычислить gate.
   *                        Если не передан — выбирается текущий уровень
   *                        пользователя.
   */
  async getGate(userId: string, fromLevel?: CourseLevel): Promise<LevelGateResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        ratingPuzzle: true,
        ratingRapid: true,
        gamesPlayedRapid: true,
        gamesPlayedBlitz: true,
        gamesPlayedClassical: true,
      },
    });

    const level: CourseLevel =
      fromLevel ?? (await this.resolveCurrentLevel(userId, user));

    if (level === 'advanced') {
      // Терминальный уровень: дальше некуда.
      return {
        currentLevel: 'advanced',
        nextLevel: null,
        unlocked: true,
        blockers: [],
      };
    }

    if (level === 'intermediate') {
      const blockers = await this.computeIntermediateBlockers(userId, user);
      return {
        currentLevel: 'intermediate',
        nextLevel: 'advanced',
        unlocked: blockers.length === 0,
        blockers,
      };
    }

    // default: beginner
    const blockers = await this.computeBeginnerBlockers(userId, user);
    return {
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: blockers.length === 0,
      blockers,
    };
  }

  /**
   * Текущий уровень: самый младший уровень, чей gate не открыт. Если
   * beginner-gate закрыт — `intermediate`. Если и intermediate-gate тоже
   * закрыт — `advanced` (и дальше переходов нет).
   */
  private async resolveCurrentLevel(
    userId: string,
    user: CurrentUserForGate,
  ): Promise<CourseLevel> {
    const beginnerBlockers = await this.computeBeginnerBlockers(userId, user);
    if (beginnerBlockers.length > 0) return 'beginner';

    const intermediateBlockers = await this.computeIntermediateBlockers(userId, user);
    if (intermediateBlockers.length > 0) return 'intermediate';

    return 'advanced';
  }

  private async computeBeginnerBlockers(
    userId: string,
    user: CurrentUserForGate,
  ): Promise<LevelGateBlocker[]> {
    const blockers: LevelGateBlocker[] = [];

    // 1) курс «beginner» завершён: все опубликованные уроки пройдены.
    const courseBlocker = await this.courseCompletionBlocker(
      userId,
      this.BEGINNER_TO_INTERMEDIATE.courseSlug,
    );
    if (courseBlocker) blockers.push(courseBlocker);

    // 2) puzzle-рейтинг
    if (user.ratingPuzzle < this.BEGINNER_TO_INTERMEDIATE.minPuzzleRating) {
      blockers.push({
        kind: 'puzzle_rating',
        required: this.BEGINNER_TO_INTERMEDIATE.minPuzzleRating,
        current: user.ratingPuzzle,
      });
    }

    // 3) сыграно партий rapid+blitz+classical
    const played = user.gamesPlayedRapid + user.gamesPlayedBlitz + user.gamesPlayedClassical;
    if (played < this.BEGINNER_TO_INTERMEDIATE.minGamesPlayed) {
      blockers.push({
        kind: 'games_played',
        required: this.BEGINNER_TO_INTERMEDIATE.minGamesPlayed,
        current: played,
      });
    }

    return blockers;
  }

  private async computeIntermediateBlockers(
    userId: string,
    user: CurrentUserForGate,
  ): Promise<LevelGateBlocker[]> {
    const blockers: LevelGateBlocker[] = [];

    // 1) курс «intermediate» завершён.
    const courseBlocker = await this.courseCompletionBlocker(
      userId,
      this.INTERMEDIATE_TO_ADVANCED.courseSlug,
    );
    if (courseBlocker) blockers.push(courseBlocker);

    // 2) puzzle-рейтинг ≥ 1700
    if (user.ratingPuzzle < this.INTERMEDIATE_TO_ADVANCED.minPuzzleRating) {
      blockers.push({
        kind: 'puzzle_rating',
        required: this.INTERMEDIATE_TO_ADVANCED.minPuzzleRating,
        current: user.ratingPuzzle,
      });
    }

    // 3) rapid-рейтинг ≥ 1400
    if (user.ratingRapid < this.INTERMEDIATE_TO_ADVANCED.minRapidRating) {
      blockers.push({
        kind: 'rapid_rating',
        required: this.INTERMEDIATE_TO_ADVANCED.minRapidRating,
        current: user.ratingRapid,
      });
    }

    // 4) решено ≥ 500 задач (PuzzleAttempt.solved=true).
    // `count` использует индекс `@@index([userId])`; чтение не дорогое.
    const puzzlesSolved = await this.prisma.puzzleAttempt.count({
      where: { userId, solved: true },
    });
    if (puzzlesSolved < this.INTERMEDIATE_TO_ADVANCED.minPuzzlesSolved) {
      blockers.push({
        kind: 'puzzles_solved',
        required: this.INTERMEDIATE_TO_ADVANCED.minPuzzlesSolved,
        current: puzzlesSolved,
      });
    }

    return blockers;
  }

  /**
   * Вспомогательный метод: проверить, что все опубликованные уроки курса
   * `slug` пройдены пользователем. Возвращает `LevelGateBlocker` если есть
   * незакрытые уроки, иначе `null`.
   *
   * Особые случаи:
   *  - Если курса нет в БД (seed не применён) — считаем условие невыполненным
   *    с `lessonsRemaining=0` (как в L-15, совместимо с KS-1770).
   *  - Если в курсе 0 опубликованных уроков — условие автоматически
   *    выполнено (блокера нет).
   */
  private async courseCompletionBlocker(
    userId: string,
    slug: string,
  ): Promise<LevelGateBlocker | null> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!course) {
      return { kind: 'course_not_completed', lessonsRemaining: 0 };
    }
    const published = await this.prisma.lesson.count({
      where: { courseId: course.id, isPublished: true },
    });
    const completed = await this.prisma.userLessonProgress.count({
      where: {
        userId,
        completedAt: { not: null },
        lesson: { courseId: course.id, isPublished: true },
      },
    });
    const remaining = Math.max(0, published - completed);
    if (remaining > 0) {
      return { kind: 'course_not_completed', lessonsRemaining: remaining };
    }
    return null;
  }
}
