import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME, MATCHMAKING_BOTS } from '@kingside/shared';

/** All bot user IDs (Stockfish + matchmaking bots) */
const ALL_BOT_IDS = new Set([STOCKFISH_BOT_ID, ...MATCHMAKING_BOTS.map((b) => b.id)]);

@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    await this.ensureBotUsers();
  }

  private async ensureBotUsers(): Promise<void> {
    // Ensure Stockfish Bot (for direct play-vs-bot)
    await this.upsertBot(STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME, 'stockfish-bot@kingside.local', 1500);

    // Ensure matchmaking bots
    for (const bot of MATCHMAKING_BOTS) {
      await this.upsertBot(bot.id, bot.username, `${bot.username.toLowerCase()}@bot.kingside.local`, bot.rating);
    }

    this.logger.log(`Bot users ensured: 1 Stockfish + ${MATCHMAKING_BOTS.length} matchmaking bots`);
  }

  private async upsertBot(id: string, username: string, email: string, rating: number): Promise<void> {
    try {
      await this.prisma.user.upsert({
        where: { id },
        update: { username, isBot: true, ratingBullet: rating, ratingBlitz: rating, ratingRapid: rating, ratingClassical: rating },
        create: {
          id, username, email, passwordHash: '', isBot: true,
          ratingBullet: rating, ratingBlitz: rating, ratingRapid: rating, ratingClassical: rating,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(`Bot upsert failed for ${username}: ${(err as Error).message}`);
    }
  }

  isBotPlayer(userId: string): boolean {
    return ALL_BOT_IDS.has(userId);
  }

  /**
   * Pick a random matchmaking bot closest to the given rating.
   * Returns { id, username, botLevel } or null if no bots available.
   */
  pickBotForRating(playerRating: number): { id: string; username: string; botLevel: number; rating: number } {
    // Sort by rating distance, pick from top 3 closest
    const sorted = [...MATCHMAKING_BOTS].sort((a, b) =>
      Math.abs(a.rating - playerRating) - Math.abs(b.rating - playerRating),
    );
    const candidates = sorted.slice(0, 3);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
