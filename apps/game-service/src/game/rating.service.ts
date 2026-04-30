import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RatingProtectionService } from './rating-protection.service';

const PROVISIONAL_THRESHOLD = 20;
const K_ESTABLISHED = 32;
const K_PROVISIONAL = 40;

/**
 * KS-2166 (ADR-034 §8.2, Q2 = R1). Synthetic-партии (флаг
 * `Game.isSyntheticOpponent=true`) пересчитываются как обычные:
 * рейтинг живого изменяется по тем же формулам Elo, рейтинг
 * synthetic'а — тоже (он полноценный пользователь по Q4).
 *
 * Specific:
 *   - НЕ добавляем ветку `if isSyntheticOpponent skipRating()`.
 *   - Существующая ветка `if (game.isBot) skip` — это Workshop /
 *     Play-vs-Bot режим (Q7 = «оставить как есть»), не путать с
 *     synthetic. Synthetic в матчмейкинге проходит как live, поэтому
 *     `game.isBot=false` и сюда попадает в нормальный пересчёт.
 */
@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly protection: RatingProtectionService,
  ) {}

  async updateRatingsAfterGame(
    gameId: string,
    result: 'white' | 'black' | 'draw',
  ): Promise<{ whiteRatingBefore: number; whiteRatingAfter: number; blackRatingBefore: number; blackRatingAfter: number } | null> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: {
        whiteId: true,
        blackId: true,
        timeControlType: true,
        isBot: true,
      },
    });

    if (game.isBot) {
      // Workshop / Play-vs-Bot режим (см. ADR-034 §10.2 Q7). НЕ
      // переносить эту ветку на `isSyntheticOpponent` — synthetic-
      // партия из matchmaking-flow обрабатывается ниже как обычная
      // (KS-2166 Q2 = R1).
      this.logger.log(`Rating update skipped for game ${gameId}: bot game`);
      return null;
    }

    const check = await this.protection.validateGame(gameId);
    if (!check.allowed) {
      this.logger.warn(`Rating update skipped for game ${gameId}: ${check.reason}`);
      return null;
    }

    const ratingField = this.ratingFieldForType(game.timeControlType);
    const gamesPlayedField = this.gamesPlayedFieldForType(game.timeControlType);

    const [white, black] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: game.whiteId },
        select: { [ratingField]: true, [gamesPlayedField]: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: game.blackId },
        select: { [ratingField]: true, [gamesPlayedField]: true },
      }),
    ]);

    const whiteRating = (white as any)[ratingField] as number;
    const blackRating = (black as any)[ratingField] as number;
    const whiteGamesPlayed = (white as any)[gamesPlayedField] as number;
    const blackGamesPlayed = (black as any)[gamesPlayedField] as number;

    const whiteK = whiteGamesPlayed < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_ESTABLISHED;
    const blackK = blackGamesPlayed < PROVISIONAL_THRESHOLD ? K_PROVISIONAL : K_ESTABLISHED;

    const expectedWhite = 1 / (1 + Math.pow(10, (blackRating - whiteRating) / 400));
    const expectedBlack = 1 - expectedWhite;

    const scoreWhite = result === 'white' ? 1 : result === 'draw' ? 0.5 : 0;
    const scoreBlack = 1 - scoreWhite;

    const newWhiteRating = Math.round(whiteRating + whiteK * (scoreWhite - expectedWhite));
    const newBlackRating = Math.round(blackRating + blackK * (scoreBlack - expectedBlack));

    await Promise.all([
      this.prisma.user.update({
        where: { id: game.whiteId },
        data: {
          [ratingField]: newWhiteRating,
          [gamesPlayedField]: { increment: 1 },
        },
      }),
      this.prisma.user.update({
        where: { id: game.blackId },
        data: {
          [ratingField]: newBlackRating,
          [gamesPlayedField]: { increment: 1 },
        },
      }),
      this.prisma.game.update({
        where: { id: gameId },
        data: {
          whiteRatingBefore: whiteRating,
          blackRatingBefore: blackRating,
          whiteRatingAfter: newWhiteRating,
          blackRatingAfter: newBlackRating,
        },
      }),
      // Record rating history for both players
      this.prisma.ratingHistory.create({
        data: { userId: game.whiteId, category: game.timeControlType, rating: newWhiteRating, gameId },
      }),
      this.prisma.ratingHistory.create({
        data: { userId: game.blackId, category: game.timeControlType, rating: newBlackRating, gameId },
      }),
    ]);

    this.logger.log(
      `Ratings updated for game ${gameId}: white ${whiteRating}->${newWhiteRating} (K=${whiteK}), black ${blackRating}->${newBlackRating} (K=${blackK})`,
    );

    return {
      whiteRatingBefore: whiteRating,
      whiteRatingAfter: newWhiteRating,
      blackRatingBefore: blackRating,
      blackRatingAfter: newBlackRating,
    };
  }

  private ratingFieldForType(type: string): string {
    const map: Record<string, string> = {
      bullet: 'ratingBullet',
      blitz: 'ratingBlitz',
      rapid: 'ratingRapid',
      classical: 'ratingClassical',
    };
    return map[type] ?? 'ratingBlitz';
  }

  private gamesPlayedFieldForType(type: string): string {
    const map: Record<string, string> = {
      bullet: 'gamesPlayedBullet',
      blitz: 'gamesPlayedBlitz',
      rapid: 'gamesPlayedRapid',
      classical: 'gamesPlayedClassical',
    };
    return map[type] ?? 'gamesPlayedBlitz';
  }
}
