jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { BotGameService } from './bot-game.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME, MATCHMAKING_BOTS } from '@kingside/shared';

describe('BotGameService', () => {
  let service: BotGameService;
  let prisma: any;

  const humanId = 'human-player';

  beforeEach(() => {
    prisma = {
      user: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };

    service = new BotGameService(prisma);
  });

  describe('isBotPlayer', () => {
    it('should return true for Stockfish bot ID', () => {
      expect(service.isBotPlayer(STOCKFISH_BOT_ID)).toBe(true);
    });

    it('should return true for any matchmaking bot ID', () => {
      for (const bot of MATCHMAKING_BOTS) {
        expect(service.isBotPlayer(bot.id)).toBe(true);
      }
    });

    it('should return false for human ID', () => {
      expect(service.isBotPlayer(humanId)).toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('should upsert Stockfish bot user on init', async () => {
      await service.onModuleInit();

      expect(prisma.user.upsert).toHaveBeenCalledWith(
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

    it('should upsert every matchmaking bot on init', async () => {
      await service.onModuleInit();

      // 1 Stockfish + N matchmaking bots
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1 + MATCHMAKING_BOTS.length);
    });

    it('should swallow upsert errors without throwing (logs warning)', async () => {
      prisma.user.upsert.mockRejectedValue(new Error('DB down'));

      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('pickBotForRating', () => {
    it('should return a matchmaking bot', () => {
      const bot = service.pickBotForRating(1500);

      expect(bot).toBeDefined();
      expect(bot.id).toBeDefined();
      expect(bot.username).toBeDefined();
      expect(typeof bot.botLevel).toBe('number');
    });

    it('should prefer bots closest to given rating', () => {
      // Run multiple times to account for randomness within top-3 candidates
      const ratings = [800, 1200, 1600, 2000, 2400];
      for (const rating of ratings) {
        const bot = service.pickBotForRating(rating);
        const distances = MATCHMAKING_BOTS
          .map((b) => Math.abs(b.rating - rating))
          .sort((a, b) => a - b);
        const top3MaxDistance = distances[Math.min(2, distances.length - 1)];
        expect(Math.abs(bot.rating - rating)).toBeLessThanOrEqual(top3MaxDistance);
      }
    });
  });
});
