import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PuzzleRatingService {
  private readonly logger = new Logger(PuzzleRatingService.name);

  private readonly K = 32;

  calculateNewRating(
    playerRating: number,
    puzzleRating: number,
    solved: boolean,
  ): number {
    const expected = 1 / (1 + Math.pow(10, (puzzleRating - playerRating) / 400));
    const score = solved ? 1 : 0;
    const newRating = Math.round(playerRating + this.K * (score - expected));
    return Math.max(100, newRating);
  }
}
