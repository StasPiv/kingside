jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { BotGameService } from './bot-game.service';
import {
  STOCKFISH_BOT_ID,
  STOCKFISH_BOT_USERNAME,
  MATCHMAKING_BOTS,
} from '@kingside/shared';

/**
 * KS-3559. BotGameService обслуживает Workshop (STOCKFISH_BOT_ID) +
 * matchmaking pool (MATCHMAKING_BOTS = 12 ботов). После KS-2165 (revert
 * synthetic users) и KS-3559 (возврат client-side bot fallback'а)
 * isBotPlayer/upsert работают для обоих наборов.
 */
describe('BotGameService — KS-3559', () => {
  let service: BotGameService;
  let prisma: { user: { upsert: jest.Mock } };

  const humanId = 'human-player';

  beforeEach(() => {
    prisma = {
      user: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
    service = new BotGameService(prisma as never);
  });

  describe('isBotPlayer', () => {
    it('returns true для Stockfish bot ID', () => {
      expect(service.isBotPlayer(STOCKFISH_BOT_ID)).toBe(true);
    });

    it('returns true для каждого из 12 MATCHMAKING_BOTS', () => {
      for (const bot of MATCHMAKING_BOTS) {
        expect(service.isBotPlayer(bot.id)).toBe(true);
      }
    });

    it('returns false для human ID', () => {
      expect(service.isBotPlayer(humanId)).toBe(false);
    });

    it('returns false для рандомного UUID не из bot-pool-ов', () => {
      expect(
        service.isBotPlayer('00000000-0000-4000-c000-000000000099'),
      ).toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('upsert для Stockfish + всех 12 matchmaking-ботов (всего 13)', async () => {
      await service.onModuleInit();
      expect(prisma.user.upsert).toHaveBeenCalledTimes(
        1 + MATCHMAKING_BOTS.length,
      );
      // Stockfish upsert первым.
      expect(prisma.user.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { id: STOCKFISH_BOT_ID },
          create: expect.objectContaining({
            id: STOCKFISH_BOT_ID,
            username: STOCKFISH_BOT_USERNAME,
            email: 'stockfish-bot@kingside.local',
            isBot: true,
          }),
        }),
      );
    });

    it('каждый matchmaking-бот upsert-ится с rating и isBot=true, isSynthetic=false', async () => {
      await service.onModuleInit();
      for (const bot of MATCHMAKING_BOTS) {
        expect(prisma.user.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: bot.id },
            update: expect.objectContaining({
              username: bot.username,
              isBot: true,
              isSynthetic: false,
              ratingBullet: bot.rating,
              ratingBlitz: bot.rating,
              ratingRapid: bot.rating,
              ratingClassical: bot.rating,
            }),
            create: expect.objectContaining({
              id: bot.id,
              username: bot.username,
              isBot: true,
              ratingBullet: bot.rating,
            }),
          }),
        );
      }
    });

    it('не падает при ошибке upsert (warning в лог)', async () => {
      prisma.user.upsert.mockRejectedValue(new Error('DB down'));
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('pickBotForRating', () => {
    it('всегда возвращает бота из MATCHMAKING_BOTS', () => {
      for (const playerRating of [400, 800, 1500, 2200, 3000]) {
        const bot = service.pickBotForRating(playerRating);
        expect(MATCHMAKING_BOTS.map((b) => b.id)).toContain(bot.id);
      }
    });

    it('для рейтинга 1500 выбирает из top-3 ближайших', () => {
      // Sorted by |rating - 1500|: KnightFork99(1500), QueenGambit(1400),
      // DarkSquares(1600). Все три имеют рейтинги в +- 100.
      const sorted = [...MATCHMAKING_BOTS]
        .sort(
          (a, b) =>
            Math.abs(a.rating - 1500) - Math.abs(b.rating - 1500),
        )
        .slice(0, 3);
      const expectedIds = sorted.map((b) => b.id);

      // Тянем pick 30 раз; ВСЕ результаты должны быть из top-3.
      for (let i = 0; i < 30; i++) {
        const picked = service.pickBotForRating(1500);
        expect(expectedIds).toContain(picked.id);
      }
    });

    it('для низкого рейтинга 400 выдаёт самых слабых', () => {
      const sorted = [...MATCHMAKING_BOTS]
        .sort(
          (a, b) =>
            Math.abs(a.rating - 400) - Math.abs(b.rating - 400),
        )
        .slice(0, 3);
      const expectedIds = sorted.map((b) => b.id);
      for (let i = 0; i < 20; i++) {
        expect(expectedIds).toContain(service.pickBotForRating(400).id);
      }
    });
  });
});
