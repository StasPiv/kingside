import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  STOCKFISH_BOT_ID,
  STOCKFISH_BOT_USERNAME,
  MATCHMAKING_BOTS,
  type MatchmakingBot,
} from '@kingside/shared';

/**
 * KS-2165 → KS-3559. Сервис обслуживает:
 *  1. Workshop / Play-vs-Bot режим — `STOCKFISH_BOT_ID` (явный bot,
 *     не пересекается с matchmaking).
 *  2. KS-3559: возвращённый matchmaking bot-pool — 12 ботов из
 *     `MATCHMAKING_BOTS` (shared) для 30-секундного client-side
 *     Stockfish fallback'а. Embedded synthetic users (KS-2159..KS-2180)
 *     откатаны 30.04, ADR-034 v2 (WS-bot-fleet) ещё не реализован —
 *     это временный возврат прежнего поведения.
 */
@Injectable()
export class BotGameService implements OnModuleInit {
  private readonly logger = new Logger(BotGameService.name);

  /** KS-3559. Union STOCKFISH + 12 matchmaking-ботов для isBotPlayer-проверки. */
  private static readonly ALL_BOT_IDS: ReadonlySet<string> = new Set<string>([
    STOCKFISH_BOT_ID,
    ...MATCHMAKING_BOTS.map((b) => b.id),
  ]);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureBotUsers();
  }

  /**
   * KS-3559. Upsert'ит все bot-аккаунты на старте: Stockfish (Workshop) +
   * 12 matchmaking-ботов. Идемпотентно. Если бот ранее был помечен
   * `isSynthetic=true` (data-migration KS-2160 — между KS-1523 и
   * KS-3559), снимаем флаг и возвращаем `isBot=true`.
   */
  private async ensureBotUsers(): Promise<void> {
    await this.upsertBot(
      STOCKFISH_BOT_ID,
      STOCKFISH_BOT_USERNAME,
      'stockfish-bot@kingside.local',
      1500,
    );

    for (const bot of MATCHMAKING_BOTS) {
      await this.upsertBot(
        bot.id,
        bot.username,
        `${bot.username.toLowerCase()}@bot.kingside.local`,
        bot.rating,
      );
    }

    this.logger.log(
      `Bot users ensured: 1 Stockfish + ${MATCHMAKING_BOTS.length} matchmaking bots`,
    );
  }

  private async upsertBot(
    id: string,
    username: string,
    email: string,
    rating: number,
  ): Promise<void> {
    try {
      await this.prisma.user.upsert({
        where: { id },
        update: {
          username,
          isBot: true,
          // KS-3559: возвращаем флаги для UUID-ов, помеченных
          // KS-2160 как synthetic — после KS-2165 revert они должны
          // снова быть обычными ботами.
          isSynthetic: false,
          ratingBullet: rating,
          ratingBlitz: rating,
          ratingRapid: rating,
          ratingClassical: rating,
        },
        create: {
          id,
          username,
          email,
          passwordHash: '',
          isBot: true,
          ratingBullet: rating,
          ratingBlitz: rating,
          ratingRapid: rating,
          ratingClassical: rating,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Bot upsert failed for ${username}: ${(err as Error).message}`,
      );
    }
  }

  /** True если userId — bot (Stockfish или один из 12 matchmaking). */
  isBotPlayer(userId: string): boolean {
    return BotGameService.ALL_BOT_IDS.has(userId);
  }

  /**
   * KS-3559. Подбирает matchmaking-бота близкого по рейтингу. Берёт
   * top-3 closest и выдаёт случайного — даёт разнообразие никнеймов
   * при повторных fallback'ах одного и того же пользователя.
   */
  pickBotForRating(playerRating: number): MatchmakingBot {
    const sorted = [...MATCHMAKING_BOTS].sort(
      (a, b) =>
        Math.abs(a.rating - playerRating) -
        Math.abs(b.rating - playerRating),
    );
    const candidates = sorted.slice(0, 3);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
