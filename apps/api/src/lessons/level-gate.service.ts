import { Injectable } from '@nestjs/common';
import type {
  LevelGateBlocker,
  LevelGateResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * L-15 (KS-1770): критерий перехода между уровнями курсов.
 * Источник правил — ADR-024 §2.3.
 *
 * MVP: реализован переход Beginner → Intermediate. Переход
 * Intermediate → Advanced появится в L-26.
 *
 * Условия Beginner → Intermediate:
 *  - курс `beginner` завершён (все `isPublished=true` уроки имеют
 *    `UserLessonProgress.completedAt != null`);
 *  - `user.ratingPuzzle >= 1200`;
 *  - суммарно `gamesPlayedRapid + gamesPlayedBlitz + gamesPlayedClassical >= 20`
 *    (bullet не учитываем — договорённость в карточке KS-1770;
 *    ADR-024 §2.3 включает bullet, но координатор явно указал только
 *    rapid/blitz/classical).
 */
@Injectable()
export class LevelGateService {
  private readonly BEGINNER_TO_INTERMEDIATE = {
    courseSlug: 'beginner',
    minPuzzleRating: 1200,
    minGamesPlayed: 20,
  };

  constructor(private readonly prisma: PrismaService) {}

  async getGate(userId: string): Promise<LevelGateResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        ratingPuzzle: true,
        gamesPlayedRapid: true,
        gamesPlayedBlitz: true,
        gamesPlayedClassical: true,
      },
    });

    // В MVP поддерживаем единственный переход: beginner → intermediate.
    // currentLevel фиксирован как 'beginner' до L-26 (где появится
    // intermediate→advanced) — переход не завязан на `ratingPuzzle`.
    // Gate всегда проверяет три условия перехода beginner→intermediate,
    // независимо от того, перерос ли пользователь уже порог по рейтингу.
    const blockers = await this.computeBeginnerBlockers(userId, user);
    return {
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: blockers.length === 0,
      blockers,
    };
  }

  private async computeBeginnerBlockers(
    userId: string,
    user: {
      ratingPuzzle: number;
      gamesPlayedRapid: number;
      gamesPlayedBlitz: number;
      gamesPlayedClassical: number;
    },
  ): Promise<LevelGateBlocker[]> {
    const blockers: LevelGateBlocker[] = [];

    // 1) курс «beginner» завершён: все опубликованные уроки пройдены.
    const course = await this.prisma.course.findUnique({
      where: { slug: this.BEGINNER_TO_INTERMEDIATE.courseSlug },
      select: { id: true },
    });
    if (course) {
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
        blockers.push({ kind: 'course_not_completed', lessonsRemaining: remaining });
      }
    } else {
      // Если курса нет в БД (не накатан seed) — считаем, что условие
      // не выполнено, в lessonsRemaining возвращаем 0 (неизвестно).
      blockers.push({ kind: 'course_not_completed', lessonsRemaining: 0 });
    }

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
}
