import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RatingChange {
  userRatingBefore: number;
  userRatingAfter: number;
  puzzleRatingBefore: number;
  puzzleRatingAfter: number;
}

@Injectable()
export class PuzzleRatingService {
  private readonly logger = new Logger(PuzzleRatingService.name);
  private readonly K_USER = 32;
  private readonly K_PUZZLE = 8;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculate and apply Elo rating changes after a puzzle attempt.
   *
   * The user "plays" against the puzzle: solving counts as a win (score=1),
   * failing counts as a loss (score=0).
   * The puzzle rating adjusts in the opposite direction with a smaller K-factor
   * to keep puzzle ratings more stable.
   */
  async applyRatingChange(
    userId: string,
    puzzleId: string,
    solved: boolean,
  ): Promise<RatingChange> {
    const [user, puzzle] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ratingPuzzle: true },
      }),
      this.prisma.puzzle.findUniqueOrThrow({
        where: { id: puzzleId },
        select: { rating: true, ratingDeviation: true },
      }),
    ]);

    const userRating = user.ratingPuzzle;
    const puzzleRating = puzzle.rating;

    const expectedUser =
      1 / (1 + Math.pow(10, (puzzleRating - userRating) / 400));

    const score = solved ? 1 : 0;

    const newUserRating = Math.round(
      userRating + this.K_USER * (score - expectedUser),
    );
    const newPuzzleRating = Math.round(
      puzzleRating + this.K_PUZZLE * (expectedUser - score),
    );

    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: { ratingPuzzle: newUserRating },
      }),
      this.prisma.puzzle.update({
        where: { id: puzzleId },
        data: { rating: newPuzzleRating },
      }),
    ]);

    this.logger.log(
      `Puzzle rating: user ${userRating}->${newUserRating}, puzzle ${puzzleRating}->${newPuzzleRating} (${solved ? 'solved' : 'failed'})`,
    );

    return {
      userRatingBefore: userRating,
      userRatingAfter: newUserRating,
      puzzleRatingBefore: puzzleRating,
      puzzleRatingAfter: newPuzzleRating,
    };
  }
}
