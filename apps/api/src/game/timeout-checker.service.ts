import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameService } from './game.service';
import { GameClockService } from './game-clock.service';
import { GameGateway } from './game.gateway';
import { GameResult } from '../generated/prisma/enums';

/** Check for timed-out games every 5 seconds */
const CHECK_INTERVAL_MS = 5_000;

@Injectable()
export class TimeoutCheckerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutCheckerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gameService: GameService,
    private readonly clockService: GameClockService,
    private readonly gateway: GameGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.log('Timeout checker started (every 5s)');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    try {
      const activeGames = await this.prisma.game.findMany({
        where: { status: 'active' },
        select: { id: true },
      });

      for (const game of activeGames) {
        await this.checkGame(game.id);
      }
    } catch (e: unknown) {
      this.logger.error(`Timeout check error: ${(e as Error).message}`);
    }
  }

  private async checkGame(gameId: string): Promise<void> {
    const raw = await this.redis.hgetall(`game:${gameId}:state`);
    if (!raw.fen || raw.status !== 'active') return;

    const activeColor = raw.active_color === 'black' ? 'black' as const : 'white' as const;
    const { timedOut } = await this.clockService.checkTimeout(gameId, activeColor);

    if (!timedOut) return;

    const result: GameResult = activeColor === 'white' ? 'black' : 'white';
    try {
      const ratingChange = await this.gameService.endGame(gameId, result, 'timeout');
      this.gateway.emitGameEnd(gameId, result, 'timeout', ratingChange || undefined);
      this.logger.log(`Game ${gameId} ended by timeout: ${activeColor} ran out of time`);
    } catch {
      // Game may have already ended via another path
    }
  }
}
