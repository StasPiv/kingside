import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from './game.service';
import { BotGameService } from './bot-game.service';
import { GameGateway } from './game.gateway';
import { DEADLINES_KEY } from './game-clock.service';
import { GameResult } from '../generated/prisma/enums';
import { STOCKFISH_BOT_ID } from '@kingside/shared';

/** Check for timed-out games every 5 seconds */
const CHECK_INTERVAL_MS = 5_000;
/** Fallback to server bot if client-side bot doesn't move within this time */
const BOT_CLIENT_FALLBACK_MS = 30_000;

@Injectable()
export class TimeoutCheckerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutCheckerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly botGameService: BotGameService,
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
      const now = Date.now();
      const expiredGameIds = await this.redis.zrangebyscore(DEADLINES_KEY, 0, now);
      for (const gameId of expiredGameIds) {
        await this.handleTimeout(gameId);
      }
    } catch (e: unknown) {
      this.logger.error(`Timeout check error: ${(e as Error).message}`);
    }

    try {
      await this.checkBotClientFallback();
    } catch (e: unknown) {
      this.logger.error(`Bot client fallback check error: ${(e as Error).message}`);
    }
  }

  private async handleTimeout(gameId: string): Promise<void> {
    const removed = await this.redis.zrem(DEADLINES_KEY, gameId);
    if (!removed) return;

    const raw = await this.redis.hgetall(`game:${gameId}:state`);
    if (!raw.fen || raw.status !== 'active') return;

    const activeColor = raw.active_color === 'black' ? 'black' as const : 'white' as const;
    const result: GameResult = activeColor === 'white' ? 'black' : 'white';

    const clockRaw = await this.redis.hgetall(`game:${gameId}:clocks`);
    this.logger.log(`Game ${gameId}: ${activeColor} timed out. clocks: white_ms=${clockRaw.white_ms} black_ms=${clockRaw.black_ms} last_tick=${clockRaw.last_tick} running=${clockRaw.running}`);
    try {
      const ratingChange = await this.gameService.endGame(gameId, result, 'timeout');
      this.gateway.emitGameEnd(gameId, result, 'timeout', ratingChange || undefined);
      this.logger.log(`Game ${gameId} ended by timeout: ${activeColor} ran out of time`);
    } catch (e: unknown) {
      this.logger.warn(`Game ${gameId} timeout endGame failed: ${(e as Error).message}`);
    }
  }

  /**
   * If a client-side bot game has the bot's turn idle for >30s,
   * fall back to server-side Stockfish.
   */
  private async checkBotClientFallback(): Promise<void> {
    const games = await this.prisma.game.findMany({
      where: { isBot: true, botClientSide: true, status: 'active' },
      select: { id: true, whiteId: true, blackId: true },
    });

    const now = Date.now();
    for (const game of games) {
      const raw = await this.redis.hgetall(`game:${game.id}:state`);
      if (!raw.fen || raw.status !== 'active') continue;

      const activeColor = raw.active_color as 'white' | 'black';
      const nextPlayerId = activeColor === 'white' ? game.whiteId : game.blackId;
      if (nextPlayerId !== STOCKFISH_BOT_ID) continue; // not bot's turn

      const clockRaw = await this.redis.hgetall(`game:${game.id}:clocks`);
      const lastTick = parseInt(clockRaw.last_tick || '0', 10);
      if (lastTick <= 0 || now - lastTick < BOT_CLIENT_FALLBACK_MS) continue;

      this.logger.warn(`Bot client fallback: game ${game.id.slice(0, 8)} bot idle ${Math.round((now - lastTick) / 1000)}s — triggering server move`);
      try {
        const botResult = await this.botGameService.maybeBotReply(game.id);
        if (botResult) {
          const movePayload = {
            uci: botResult.uci,
            san: botResult.san,
            fen: botResult.fen,
            clocks: { whiteMs: botResult.clocks.whiteMs, blackMs: botResult.clocks.blackMs },
            moveFlags: botResult.moveFlags,
          };
          this.gateway.server.to(`game:${game.id}`).emit('game:move_server', movePayload);

          if (botResult.gameOver) {
            await this.gateway.emitGameEnd(game.id, botResult.result as GameResult, botResult.termination!);
          }
        }
      } catch (e: unknown) {
        this.logger.error(`Bot client fallback failed for game ${game.id}: ${(e as Error).message}`);
      }
    }
  }
}
