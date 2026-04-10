import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyTimeControl,
  type TimeControlCategory,
  type RatingFilter,
} from '@kingside/shared';

interface RatingRange {
  min: number;
  max: number;
}

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  ratingRange?: RatingRange;
}

@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Add player to matchmaking queue. Matching is handled by matchmaker worker.
   */
  async joinQueue(
    userId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
    _isOnline?: (userId: string) => Promise<boolean>,
    ratingFilter?: RatingFilter,
  ): Promise<null> {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const ratingField = this.ratingFieldForCategory(timeControlType);
    const rating = user[ratingField];
    const ratingRange = this.resolveRatingRange(rating, ratingFilter);

    const queueKey = `matchmaking:${timeControlType}`;

    const entry: QueueEntry = {
      userId,
      rating,
      timeInitialSec,
      timeIncrementSec,
      ratingRange,
    };

    await this.redis.zadd(queueKey, rating, JSON.stringify(entry));
    this.logger.log(`joinQueue: ${userId} (rating ${rating}) added to ${queueKey}`);
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

  private resolveRatingRange(
    playerRating: number,
    filter?: RatingFilter,
  ): RatingRange | undefined {
    if (!filter) return undefined;

    const { minRating, maxRating, ratingDelta } = filter;

    if (ratingDelta !== undefined) {
      return {
        min: playerRating - ratingDelta,
        max: playerRating + ratingDelta,
      };
    }

    if (minRating !== undefined || maxRating !== undefined) {
      return {
        min: minRating ?? 0,
        max: maxRating ?? Infinity,
      };
    }

    return undefined;
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
