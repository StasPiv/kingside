import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { classifyTimeControl, type TimeControlCategory, type RatingRange } from '@kingside/shared';

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  ratingRange?: RatingRange;
}

@Injectable()
export class MatchmakingService {
  private readonly DEFAULT_RATING_RANGE = 200;

  constructor(
    private readonly redis: RedisService,
    private readonly gameService: GameService,
    private readonly prisma: PrismaService,
  ) {}

  async joinQueue(
    userId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
    isOnline?: (userId: string) => Promise<boolean>,
    ratingRange?: RatingRange,
  ): Promise<{ gameId: string; color: string; opponent: any } | null> {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const ratingField = this.ratingFieldForCategory(timeControlType);
    const rating = user[ratingField];

    const { minRating, maxRating } = this.resolveRatingBounds(rating, ratingRange);

    const queueKey = `matchmaking:${timeControlType}`;

    // Look for opponent in rating range
    const candidates = await this.redis.zrangebyscore(
      queueKey,
      minRating,
      maxRating,
    );

    for (const candidateData of candidates) {
      const candidate: QueueEntry = JSON.parse(candidateData);

      if (
        candidate.userId === userId ||
        candidate.timeInitialSec !== timeInitialSec ||
        candidate.timeIncrementSec !== timeIncrementSec
      ) {
        continue;
      }

      // Check mutual rating range compatibility:
      // Our rating must also fall within the candidate's acceptable range
      const candidateBounds = this.resolveRatingBounds(candidate.rating, candidate.ratingRange);
      if (rating < candidateBounds.minRating || rating > candidateBounds.maxRating) {
        continue;
      }

      // Check if candidate is still online
      if (isOnline && !(await isOnline(candidate.userId))) {
        await this.redis.zrem(queueKey, candidateData);
        continue;
      }

      // Remove opponent from queue
      await this.redis.zrem(queueKey, candidateData);

      // Randomly assign colors
      const whiteId = Math.random() < 0.5 ? userId : candidate.userId;
      const blackId = whiteId === userId ? candidate.userId : userId;

      const game = await this.prisma.game.create({
        data: {
          whiteId,
          blackId,
          status: 'waiting',
          timeControlType,
          timeInitialSec,
          timeIncrementSec,
        },
      });

      await this.gameService.initGame(game.id);

      const opponent = await this.prisma.user.findUnique({
        where: { id: candidate.userId },
        select: { id: true, username: true },
      });

      return {
        gameId: game.id,
        color: whiteId === userId ? 'white' : 'black',
        opponent,
      };
    }

    // No match found - add to queue
    const entry: QueueEntry = {
      userId,
      rating,
      timeInitialSec,
      timeIncrementSec,
      ratingRange,
    };

    await this.redis.zadd(queueKey, rating, JSON.stringify(entry));
    return null;
  }

  async leaveQueue(userId: string, category: TimeControlCategory) {
    const queueKey = `matchmaking:${category}`;
    const members = await this.redis.zrange(queueKey, 0, -1);

    for (const member of members) {
      const entry: QueueEntry = JSON.parse(member);
      if (entry.userId === userId) {
        await this.redis.zrem(queueKey, member);
        return true;
      }
    }

    return false;
  }

  private resolveRatingBounds(
    playerRating: number,
    ratingRange?: RatingRange,
  ): { minRating: number; maxRating: number } {
    if (!ratingRange) {
      return {
        minRating: playerRating - this.DEFAULT_RATING_RANGE,
        maxRating: playerRating + this.DEFAULT_RATING_RANGE,
      };
    }

    if (ratingRange.mode === 'absolute') {
      return {
        minRating: ratingRange.min,
        maxRating: ratingRange.max,
      };
    }

    // relative mode
    return {
      minRating: playerRating - ratingRange.below,
      maxRating: playerRating + ratingRange.above,
    };
  }

  private ratingFieldForCategory(
    category: TimeControlCategory,
  ): 'ratingBullet' | 'ratingBlitz' | 'ratingRapid' | 'ratingClassical' {
    const map = {
      bullet: 'ratingBullet' as const,
      blitz: 'ratingBlitz' as const,
      rapid: 'ratingRapid' as const,
      classical: 'ratingClassical' as const,
    };
    return map[category];
  }
}
