jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { BotGameService } from './bot-game.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';

/**
 * KS-2165 (B6). Тесты обновлены: 12-ботный пул `MATCHMAKING_BOTS` удалён,
 * `BotGameService` теперь обслуживает только Workshop / Play-vs-Bot
 * (один Stockfish-bot). `pickBotForRating` тоже удалён. Embedded
 * synthetic-архитектура откатана 30.04 (см. ADR-034 v2).
 */
describe('BotGameService — KS-2165', () => {
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
    it('returns true только для Stockfish bot ID', () => {
      expect(service.isBotPlayer(STOCKFISH_BOT_ID)).toBe(true);
    });

    it('returns false для рандомного UUID (бывших MATCHMAKING_BOTS)', () => {
      // Ранее эти UUID считались bot'ами; после KS-2165 они стали
      // synthetic'ами, и BotGameService.isBotPlayer для них = false.
      expect(service.isBotPlayer('00000000-0000-4000-b000-000000000001')).toBe(
        false,
      );
    });

    it('returns false для human ID', () => {
      expect(service.isBotPlayer(humanId)).toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('один upsert на Stockfish-bot user', async () => {
      await service.onModuleInit();
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
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

    it('не падает при ошибке upsert (warning в лог)', async () => {
      prisma.user.upsert.mockRejectedValue(new Error('DB down'));
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });
});
