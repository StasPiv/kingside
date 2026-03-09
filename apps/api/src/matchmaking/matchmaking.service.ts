import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { classifyTimeControl, type TimeControlCategory } from '@kingside/shared';

export interface RatingFilter {
  ratingMin?: number;
  ratingMax?: number;
  ratingDelta?: number;
}

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  ratingFilter?: RatingFilter;
}

@Injectable()
export class MatchmakingService {
  private readonly RATING_RANGE = 200;

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
    ratingFilter?: RatingFilter,
  ): Promise<{ gameId: string; color: string; opponent: any } | null> {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const ratingField = this.ratingFieldForCategory(timeControlType);
    const rating = user[ratingField];

    const queueKey = `matchmaking:${timeControlType}`;

    // Resolve effective search range: intersection of default range and user filter
    const { min: searchMin, max: searchMax } = this.resolveSearchRange(
      rating,
      ratingFilter,
    );

    // Look for opponent in rating range
    const candidates = await this.redis.zrangebyscore(
      queueKey,
      searchMin,
      searchMax,
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

      // Check mutual rating filter: candidate's filter must also accept current user
      if (!this.isWithinFilter(rating, candidate.rating, candidate.ratingFilter)) {
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
      ...(ratingFilter && Object.keys(ratingFilter).length > 0
        ? { ratingFilter }
        : {}),
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

  /**
   * Resolve the effective search range for Redis ZRANGEBYSCORE.
   * Intersects default ±RATING_RANGE with user-specified filter.
   */
  resolveSearchRange(
    rating: number,
    filter?: RatingFilter,
  ): { min: number; max: number } {
    let min = rating - this.RATING_RANGE;
    let max = rating + this.RATING_RANGE;

    if (!filter) return { min, max };

    if (filter.ratingDelta !== undefined) {
      min = Math.max(min, rating - filter.ratingDelta);
      max = Math.min(max, rating + filter.ratingDelta);
    }

    if (filter.ratingMin !== undefined) {
      min = Math.max(min, filter.ratingMin);
    }

    if (filter.ratingMax !== undefined) {
      max = Math.min(max, filter.ratingMax);
    }

    return { min, max };
  }

  /**
   * Check if the joining player's rating is acceptable to the candidate's filter.
   * candidateRating is used to resolve relative (delta) filters.
   */
  isWithinFilter(
    joinerRating: number,
    candidateRating: number,
    candidateFilter?: RatingFilter,
  ): boolean {
    if (!candidateFilter) return true;

    const { min, max } = this.resolveSearchRange(candidateRating, candidateFilter);
    return joinerRating >= min && joinerRating <= max;
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
