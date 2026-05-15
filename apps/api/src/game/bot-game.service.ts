import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

/**
 * KS-2165 (B6). Сервис обслуживает ТОЛЬКО Workshop / Play-vs-Bot режим
 * (Q7 ADR-034 — оставляем как есть). 12-ботный пул `MATCHMAKING_BOTS`
 * удалён вместе с 30-секундным client-side fallback'ом; их роль теперь
 * выполняют synthetic-юзеры (KS-2159 пакет).
 */
@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  constructor(private readonly prisma: PrismaService) {}

  // KS-3059: Stockfish bot user нужен только Workshop / Play-vs-Bot
  // (не критично для отклика api). Fire-and-forget — не блокирует
  // startup на upsert'е (~50-200ms холодной БД).
  onModuleInit() {
    setImmediate(() => {
      this.ensureStockfishBot().catch((err) => {
        this.logger.warn(
          `Stockfish bot init async failed: ${(err as Error).message}`,
        );
      });
    });
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
    return userId === STOCKFISH_BOT_ID;
  }
}
