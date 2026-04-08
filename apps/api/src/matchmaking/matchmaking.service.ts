import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockService } from '../user/block.service';
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
  /** Resolved absolute rating range filter (if set by the player) */
  ratingRange?: RatingRange;
}

@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);
  private readonly RATING_RANGE = 200;

  constructor(
    private readonly redis: RedisService,
    private readonly gameService: GameService,
    private readonly prisma: PrismaService,
    private readonly blockService: BlockService,
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

  /**
   * Resolve a RatingFilter into an absolute { min, max } range.
   * If no filter is provided, returns undefined (no restriction).
   */
  private resolveRatingRange(
    playerRating: number,
    filter?: RatingFilter,
  ): RatingRange | undefined {
    if (!filter) return undefined;

    const { minRating, maxRating, ratingDelta } = filter;

    // ratingDelta takes precedence when set
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

  /**
   * Check whether a match is allowed considering both players' rating filters.
   * The joining player's rating must be accepted by the candidate's filter,
   * and the candidate's rating must be accepted by the joining player's filter.
   */
  private isMatchAllowedByFilters(
    joinerRating: number,
    joinerRange: RatingRange | undefined,
    candidate: QueueEntry,
  ): boolean {
    // Joiner's filter rejects candidate?
    if (joinerRange) {
      if (candidate.rating < joinerRange.min || candidate.rating > joinerRange.max) {
        return false;
      }
    }

    // Candidate's filter rejects joiner?
    if (candidate.ratingRange) {
      if (joinerRating < candidate.ratingRange.min || joinerRating > candidate.ratingRange.max) {
        return false;
      }
    }

    return true;
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
