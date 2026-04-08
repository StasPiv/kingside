import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { DEADLINES_KEY } from './game-clock.service';
import { GameResult } from '../generated/prisma/enums';

/** Check for timed-out games every 5 seconds */
const CHECK_INTERVAL_MS = 5_000;

@Injectable()
export class TimeoutCheckerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutCheckerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly gameService: GameService,
    private readonly gateway: GameGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.log('Timeout checker started (every 5s, Redis sorted set)');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    try {
      // Single Redis call: get all games with deadline <= now
      const now = Date.now();
      const expiredGameIds = await this.redis.zrangebyscore(DEADLINES_KEY, 0, now);

      for (const gameId of expiredGameIds) {
        await this.handleTimeout(gameId);
      }
    } catch (e: unknown) {
      this.logger.error(`Timeout check error: ${(e as Error).message}`);
    }
  }

  private async handleTimeout(gameId: string): Promise<void> {
    // Remove from sorted set first to prevent duplicate processing
    const removed = await this.redis.zrem(DEADLINES_KEY, gameId);
    if (!removed) return; // Another instance already handled it

    const raw = await this.redis.hgetall(`game:${gameId}:state`);
    if (!raw.fen || raw.status !== 'active') return;

    const activeColor = raw.active_color === 'black' ? 'black' as const : 'white' as const;
    const result: GameResult = activeColor === 'white' ? 'black' : 'white';

    this.logger.log(`Game ${gameId}: ${activeColor} timed out, ending...`);
    try {
      const ratingChange = await this.gameService.endGame(gameId, result, 'timeout');
      this.gateway.emitGameEnd(gameId, result, 'timeout', ratingChange || undefined);
      this.logger.log(`Game ${gameId} ended by timeout: ${activeColor} ran out of time`);
    } catch (e: unknown) {
      this.logger.warn(`Game ${gameId} timeout endGame failed: ${(e as Error).message}`);
    }
  }
}
