import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GlickoRatingService } from './glicko-rating.service';

export interface RatingChange {
  userRatingBefore: number;
  userRatingAfter: number;
  puzzleRatingBefore: number;
  puzzleRatingAfter: number;
}

@Injectable()
export class PuzzleRatingService {
  private readonly logger = new Logger(PuzzleRatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly glicko: GlickoRatingService,
  ) {}

  /**
   * Calculate and apply Glicko-1 rating changes after a puzzle attempt.
   * Updates user rating, puzzle rating, streak, and daily snapshot.
   */
  async applyRatingChange(
    userId: string,
    puzzleId: string,
    solved: boolean,
  ): Promise<RatingChange> {
    const [user, puzzle] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ratingPuzzle: true, ratingPuzzleDev: true, puzzleStreak: true },
      }),
      this.prisma.puzzle.findUniqueOrThrow({
        where: { id: puzzleId },
        select: { rating: true, ratingDev: true, solutionMode: true },
      }),
    ]);

    // KS-2716 / ADR-055 B2. Для play-vs-engine attempts рейтинг и стрик
    // не обновляются, snapshot не пишется. Возвращаем «нулевую дельту»,
    // чтобы submitAttempt мог продолжить запись `puzzle_attempts` с теми
    // же значениями rating до/после.
    if (puzzle.solutionMode === 'play-vs-engine') {
      return {
        userRatingBefore: user.ratingPuzzle,
        userRatingAfter: user.ratingPuzzle,
        puzzleRatingBefore: puzzle.rating,
        puzzleRatingAfter: puzzle.rating,
      };
    }

    const userRating = user.ratingPuzzle;
    const userRD = user.ratingPuzzleDev;
    const puzzleRating = puzzle.rating;
    const puzzleRD = puzzle.ratingDev;

    // Glicko-1 update for user
    const userUpdate = this.glicko.updateUserRating(userRating, userRD, puzzleRating, puzzleRD, solved);

    // Glicko-1 update for puzzle
    const puzzleUpdate = this.glicko.updatePuzzleRating(puzzleRating, puzzleRD, userRating, solved);

    // Streak: solved → +1, failed → reset to 0
    const newStreak = solved ? user.puzzleStreak + 1 : 0;

    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          ratingPuzzle: userUpdate.newRating,
          ratingPuzzleDev: userUpdate.newRD,
          puzzleStreak: newStreak,
        },
      }),
      this.prisma.puzzle.update({
        where: { id: puzzleId },
        data: {
          rating: puzzleUpdate.newRating,
          ratingDev: puzzleUpdate.newRD,
        },
      }),
    ]);

    // Upsert daily snapshot
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    try {
      await this.prisma.puzzleRatingSnapshot.upsert({
        where: { userId_date: { userId, date: today } },
        update: {
          rating: userUpdate.newRating,
          attempts: { increment: 1 },
          solved: solved ? { increment: 1 } : undefined,
        },
        create: {
          userId,
          date: today,
          rating: userUpdate.newRating,
          attempts: 1,
          solved: solved ? 1 : 0,
        },
      });
    } catch (e: any) {
      this.logger.warn(`Snapshot upsert failed: ${e.message}`);
    }

    this.logger.log(
      `Puzzle rating (Glicko): user ${userRating}±${userRD}->${userUpdate.newRating}±${userUpdate.newRD}, puzzle ${puzzleRating}±${puzzleRD}->${puzzleUpdate.newRating}±${puzzleUpdate.newRD} (${solved ? 'solved' : 'failed'}) streak=${newStreak}`,
    );

    return {
      userRatingBefore: userRating,
      userRatingAfter: userUpdate.newRating,
      puzzleRatingBefore: puzzleRating,
      puzzleRatingAfter: puzzleUpdate.newRating,
    };
  }
}
