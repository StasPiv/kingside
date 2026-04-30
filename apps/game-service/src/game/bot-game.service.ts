import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

/**
 * KS-2165 (B6). Сервис обслуживает ТОЛЬКО Workshop / Play-vs-Bot режим
 * (Q7 ADR-034 — оставляем как есть). Раньше также готовил пул из 12
 * MATCHMAKING_BOTS для 30-секундного fallback'а в matchmaking; этот
 * fallback удалён (synthetic users — отдельный пул, ведётся через
 * `SyntheticProfileSeederService` и `SyntheticSchedulerService`).
 */
@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);
  /** Только Stockfish Bot (Workshop mode). */
  private readonly stockfishBotId = STOCKFISH_BOT_ID;

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    await this.ensureStockfishBot();
  }

  private async ensureStockfishBot(): Promise<void> {
    try {
      await this.prisma.user.upsert({
        where: { id: STOCKFISH_BOT_ID },
        update: {
          username: STOCKFISH_BOT_USERNAME,
          isBot: true,
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
        },
        create: {
          id: STOCKFISH_BOT_ID,
          username: STOCKFISH_BOT_USERNAME,
          email: 'stockfish-bot@kingside.local',
          passwordHash: '',
          isBot: true,
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
        },
      });
      this.logger.log('Stockfish bot user ensured (Workshop / Play-vs-Bot)');
    } catch (err: unknown) {
      this.logger.warn(
        `Stockfish bot upsert failed: ${(err as Error).message}`,
      );
    }
  }

  isBotPlayer(userId: string): boolean {
    return userId === this.stockfishBotId;
  }
}
