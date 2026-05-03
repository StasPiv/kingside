import { Injectable } from '@nestjs/common';

const Q = Math.log(10) / 400; // ~0.00575646
const MIN_RD = 30;

@Injectable()
export class GlickoRatingService {
  /**
   * Glicko-1 g(RD) function — weight factor based on opponent's rating deviation.
   */
  g(rd: number): number {
    return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
  }

  /**
   * Expected score for player with given rating against opponent.
   */
  expectedScore(playerRating: number, opponentRating: number, opponentRD: number): number {
    const gRD = this.g(opponentRD);
    return 1 / (1 + Math.pow(10, (-gRD * (playerRating - opponentRating)) / 400));
  }

  /**
   * Update puzzle rating using Glicko-1.
   * INVERSION: if player solved, puzzle "lost" (score=0 for puzzle).
   */
  updatePuzzleRating(
    puzzleRating: number,
    puzzleRD: number,
    playerRating: number,
    solved: boolean,
  ): { newRating: number; newRD: number } {
    // From puzzle's perspective: puzzle vs player
    // If player solved → puzzle lost (score=0), if failed → puzzle won (score=1)
    const puzzleScore = solved ? 0 : 1;

    // Player's RD assumed low (stable player) — use 50
    const playerRD = 50;

    const gPlayerRD = this.g(playerRD);
    const E = this.expectedScore(puzzleRating, playerRating, playerRD);

    const dSquared = 1 / (Q * Q * gPlayerRD * gPlayerRD * E * (1 - E));

    const newRating = Math.round(
      puzzleRating + (Q / (1 / (puzzleRD * puzzleRD) + 1 / dSquared)) * gPlayerRD * (puzzleScore - E),
    );

    const newRD = Math.max(
      MIN_RD,
      Math.round(Math.sqrt(1 / (1 / (puzzleRD * puzzleRD) + 1 / dSquared))),
    );

    return { newRating, newRD };
  }

  /**
   * Simple Elo K=32 update for the player's puzzle rating.
   */
  updatePlayerRating(
    playerRating: number,
    puzzleRating: number,
    solved: boolean,
  ): number {
    const K = 32;
    const expected = 1 / (1 + Math.pow(10, (puzzleRating - playerRating) / 400));
    const score = solved ? 1 : 0;
    return Math.round(playerRating + K * (score - expected));
  }

  /**
   * Glicko-1 update for the user's puzzle rating.
   * INVERSION: if user solved, user "won" (score=1).
   */
  updateUserRating(
    userRating: number,
    userRD: number,
    puzzleRating: number,
    puzzleRD: number,
    solved: boolean,
  ): { newRating: number; newRD: number } {
    return this.updateUserRatingContinuous(
      userRating,
      userRD,
      puzzleRating,
      puzzleRD,
      solved ? 1 : 0,
    );
  }

  /**
   * KS-2311 (methodology §10.5): Glicko-1 update с continuous-outcome
   * `score ∈ [0, 1]` — для drill'ов shape='squares' (IoU как сырое
   * значение). Формула Glicko-1 одинакова: подставляем score вместо
   * binary {0,1} (Glickman 1995, Appendix B).
   *
   * `updateUserRating` (binary) — тонкая обёртка над этим методом.
   */
  updateUserRatingContinuous(
    userRating: number,
    userRD: number,
    opponentRating: number,
    opponentRD: number,
    score: number,
  ): { newRating: number; newRD: number } {
    const clamped = Math.max(0, Math.min(1, score));
    const gOpponentRD = this.g(opponentRD);
    const E = this.expectedScore(userRating, opponentRating, opponentRD);
    const dSquared = 1 / (Q * Q * gOpponentRD * gOpponentRD * E * (1 - E));

    const newRating = Math.round(
      userRating +
        (Q / (1 / (userRD * userRD) + 1 / dSquared)) *
          gOpponentRD *
          (clamped - E),
    );
    const newRD = Math.max(
      MIN_RD,
      Math.round(Math.sqrt(1 / (1 / (userRD * userRD) + 1 / dSquared))),
    );
    return { newRating, newRD };
  }
}
