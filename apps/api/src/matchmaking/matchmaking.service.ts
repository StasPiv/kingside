import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { classifyTimeControl, type TimeControlCategory } from '@kingside/shared';

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
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
  ): Promise<{ gameId: string; color: string; opponent: any } | null> {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const ratingField = `rating${timeControlType.charAt(0).toUpperCase() + timeControlType.slice(1)}` as
      'ratingBullet' | 'ratingBlitz' | 'ratingRapid' | 'ratingClassical';
    const rating = user[ratingField];

    const queueKey = `matchmaking:${timeControlType}`;

    // Look for opponent in rating range
    const candidates = await this.redis.zrangebyscore(
      queueKey,
      rating - this.RATING_RANGE,
      rating + this.RATING_RANGE,
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

    // No match found — add to queue
    const entry: QueueEntry = {
      userId,
      rating,
      timeInitialSec,
      timeIncrementSec,
    };

    await this.redis.zadd(queueKey, rating, JSON.stringify(entry));
    return null;
  }

  async leaveQueue(userId: string, timeControlType: TimeControlCategory) {
    const queueKey = `matchmaking:${timeControlType}`;
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
}
