jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import {
  DEFAULT_BOT_TIMEOUT_MS,
  DEFAULT_NO_OPPONENTS_TIMEOUT_MS,
  MATCHMAKER_NO_OPPONENTS_CHANNEL,
  MatchmakingService,
  readBotFallbackEnabled,
  readBotTimeoutMs,
  readNoOpponentsTimeoutMs,
} from './matchmaking.service';
import { MATCHMAKING_BOTS } from '@kingside/shared';

describe('MatchmakingService', () => {
  let service: MatchmakingService;
  let prisma: any;
  let redis: any;
  let botGameService: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const opponentId = '22222222-2222-4222-a222-222222222222';

  // KS-3559: тесты гоняем с выключенным bot-fallback'ом, кроме явных
  // bot-fallback кейсов. Это позволяет проверять KS-2197 sweep'ом без
  // интерференции pass'а 2.
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ username: 'tester' }),
      },
      game: {
        create: jest.fn().mockResolvedValue({ id: 'game-1' }),
      },
    } as any;

    redis = {
      zadd: jest.fn().mockResolvedValue(1),
      zrange: jest.fn().mockResolvedValue([]),
      zrem: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      hset: jest.fn().mockResolvedValue(1),
    } as any;

    botGameService = {
      pickBotForRating: jest.fn().mockReturnValue(MATCHMAKING_BOTS[6]), // KnightFork99 / 1500
      isBotPlayer: jest.fn().mockReturnValue(false),
    };

    // По умолчанию bot-fallback OFF — чтобы старые тесты KS-2197 не
    // ломались. Каждый bot-fallback тест включает явно.
    process.env.MATCHMAKING_BOT_FALLBACK_ENABLED = 'false';

    service = new MatchmakingService(redis, prisma, botGameService);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('joinQueue', () => {
    beforeEach(() => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBlitz: 1500,
        ratingBullet: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });
    });

    it('should add user to queue and return null (matching done by worker)', async () => {
      const result = await service.joinQueue(userId, 300, 0);

      expect(result).toBeNull();
      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:blitz',
        1500,
        expect.stringContaining(userId),
      );
    });

    it('should use correct rating field for bullet', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBullet: 1200,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });

      await service.joinQueue(userId, 60, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:bullet',
        1200,
        expect.any(String),
      );
    });

    it('should use correct rating field for rapid', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1800,
        ratingClassical: 1500,
      });

      await service.joinQueue(userId, 600, 0);

      expect(redis.zadd).toHaveBeenCalledWith(
        'matchmaking:rapid',
        1800,
        expect.any(String),
      );
    });

    describe('rating filter', () => {
      it('should store ratingRange in queue entry', async () => {
        await service.joinQueue(
          userId, 300, 0, undefined,
          { ratingDelta: 100 },
        );

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toEqual({ min: 1400, max: 1600 });
      });

      it('should not store ratingRange when no filter', async () => {
        await service.joinQueue(userId, 300, 0);

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toBeUndefined();
      });

      it('ratingDelta takes precedence over minRating/maxRating', async () => {
        await service.joinQueue(
          userId, 300, 0, undefined,
          { minRating: 1000, maxRating: 2000, ratingDelta: 50 },
        );

        const storedEntry = JSON.parse(redis.zadd.mock.calls[0][2]);
        expect(storedEntry.ratingRange).toEqual({ min: 1450, max: 1550 });
      });
    });
  });

  /**
   * KS-2197 — sweep пустой очереди (без bot-fallback'а).
   *
   * Все кейсы здесь идут с `MATCHMAKING_BOT_FALLBACK_ENABLED=false` —
   * Pass 2 отключён, sweep'у не приходится конкурировать. Поведение
   * sweep'а — то же что и до KS-3559.
   */
  describe('processQueue — KS-2197 no_opponents sweep (bot OFF)', () => {
    function callProcessQueue(s: MatchmakingService, cat: 'bullet' | 'blitz' | 'rapid' | 'classical') {
      return (s as unknown as { processQueue: (c: string) => Promise<void> }).processQueue(cat);
    }

    it('одинокий, >60s → zrem + publish с waitedMs', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 61_000,
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(redis.zrem).toHaveBeenCalledWith('matchmaking:bullet', lonely);
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const [channel, payloadJson] = redis.publish.mock.calls[0];
      expect(channel).toBe(MATCHMAKER_NO_OPPONENTS_CHANNEL);
      const payload = JSON.parse(payloadJson);
      expect(payload).toEqual({
        userId,
        category: 'bullet',
        timeInitial: 60,
        increment: 0,
        waitedMs: 61_000,
      });
    });

    it('пара спарилась до таймаута → publish NO_OPPONENTS не вызван', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const a = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 20_000,
      });
      const b = JSON.stringify({
        userId: opponentId,
        rating: 1510,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 5_000,
      });
      redis.zrange.mockResolvedValue([a, b]);

      const createMatchedGame = jest
        .spyOn(service as unknown as { createMatchedGame: () => Promise<void> }, 'createMatchedGame')
        .mockResolvedValue(undefined);

      await callProcessQueue(service, 'bullet');

      expect(createMatchedGame).toHaveBeenCalledTimes(1);
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('одиночка не достиг таймаута (40s из 60s) → publish не вызван', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 40_000,
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(redis.publish).not.toHaveBeenCalled();
      expect(redis.zrem).not.toHaveBeenCalled();
    });

    it('paired user не получает publish даже с давним joinedAt', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const a = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 90_000,
      });
      const b = JSON.stringify({
        userId: opponentId,
        rating: 1510,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 90_000,
      });
      redis.zrange.mockResolvedValue([a, b]);

      jest
        .spyOn(service as unknown as { createMatchedGame: () => Promise<void> }, 'createMatchedGame')
        .mockResolvedValue(undefined);

      await callProcessQueue(service, 'bullet');

      expect(redis.publish).not.toHaveBeenCalled();
    });
  });

  /**
   * KS-3559 — Pass 2 bot fallback. ENV MATCHMAKING_BOT_FALLBACK_ENABLED
   * включён, дефолтный таймаут 30s.
   */
  describe('processQueue — KS-3559 bot fallback (bot ON)', () => {
    function callProcessQueue(s: MatchmakingService, cat: 'bullet' | 'blitz' | 'rapid' | 'classical') {
      return (s as unknown as { processQueue: (c: string) => Promise<void> }).processQueue(cat);
    }

    beforeEach(() => {
      process.env.MATCHMAKING_BOT_FALLBACK_ENABLED = 'true';
      // Восстанавливаем default 30s.
      delete process.env.MATCHMAKING_BOT_TIMEOUT_MS;
    });

    it('одиночка, ждёт >30s → createBotGame + game.botClientSide=true', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 31_000,
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(botGameService.pickBotForRating).toHaveBeenCalledWith(1500);
      expect(prisma.game.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isBot: true,
            botClientSide: true,
            botLevel: MATCHMAKING_BOTS[6].botLevel,
            timeControlType: 'bullet',
          }),
        }),
      );
      expect(redis.zrem).toHaveBeenCalledWith('matchmaking:bullet', lonely);
      // NO_OPPONENTS sweep — игрок уже paired, publish не вызван.
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const [channel, payloadJson] = redis.publish.mock.calls[0];
      expect(channel).toBe('matchmaker:found');
      const payload = JSON.parse(payloadJson);
      expect(payload.isBot).toBe(true);
      expect(payload.botClientSide).toBe(true);
      expect(payload.gameId).toBe('game-1');
    });

    it('одиночка, ждёт <30s → bot не подбирается', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 20_000,
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(prisma.game.create).not.toHaveBeenCalled();
      expect(redis.zrem).not.toHaveBeenCalled();
    });

    it('пара спарилась live↔live до bot-таймаута → bot не подбирается', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const a = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 5_000,
      });
      const b = JSON.stringify({
        userId: opponentId,
        rating: 1510,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 4_000,
      });
      redis.zrange.mockResolvedValue([a, b]);

      const createMatchedGame = jest
        .spyOn(service as unknown as { createMatchedGame: () => Promise<void> }, 'createMatchedGame')
        .mockResolvedValue(undefined);

      await callProcessQueue(service, 'bullet');

      expect(createMatchedGame).toHaveBeenCalledTimes(1);
      expect(botGameService.pickBotForRating).not.toHaveBeenCalled();
      expect(prisma.game.create).not.toHaveBeenCalled();
    });

    it('одиночка >30s + bot-fallback OFF → bot не подбирается, отрабатывает sweep no_opponents после 60s', async () => {
      process.env.MATCHMAKING_BOT_FALLBACK_ENABLED = 'false';
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 61_000,
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(botGameService.pickBotForRating).not.toHaveBeenCalled();
      // sweep отрабатывает > 60s.
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const [channel] = redis.publish.mock.calls[0];
      expect(channel).toBe(MATCHMAKER_NO_OPPONENTS_CHANNEL);
    });

    it('одиночка >30s + bot подобран → sweep no_opponents НЕ срабатывает (игрок уже paired)', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 90_000, // 90s — > bot timeout И > no_opponents timeout.
      });
      redis.zrange.mockResolvedValue([lonely]);

      await callProcessQueue(service, 'bullet');

      expect(prisma.game.create).toHaveBeenCalledTimes(1);
      // Только matchmaker:found, no_opponents не публикуется.
      const channels = redis.publish.mock.calls.map((c: unknown[]) => c[0]);
      expect(channels).toEqual(['matchmaker:found']);
    });
  });

  describe('readBotTimeoutMs / readBotFallbackEnabled — KS-3559', () => {
    it('ENV пуст → дефолт 30000', () => {
      expect(readBotTimeoutMs({} as NodeJS.ProcessEnv)).toBe(
        DEFAULT_BOT_TIMEOUT_MS,
      );
    });

    it('ENV число → парсится', () => {
      expect(
        readBotTimeoutMs({
          MATCHMAKING_BOT_TIMEOUT_MS: '15000',
        } as NodeJS.ProcessEnv),
      ).toBe(15_000);
    });

    it('ENV невалидный → дефолт', () => {
      expect(
        readBotTimeoutMs({
          MATCHMAKING_BOT_TIMEOUT_MS: 'foo',
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_BOT_TIMEOUT_MS);
      expect(
        readBotTimeoutMs({
          MATCHMAKING_BOT_TIMEOUT_MS: '0',
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_BOT_TIMEOUT_MS);
    });

    it('readBotFallbackEnabled: ENV не задан → true', () => {
      expect(readBotFallbackEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    });

    it('readBotFallbackEnabled: "false" → false', () => {
      expect(
        readBotFallbackEnabled({
          MATCHMAKING_BOT_FALLBACK_ENABLED: 'false',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    });

    it('readBotFallbackEnabled: иное значение → true', () => {
      expect(
        readBotFallbackEnabled({
          MATCHMAKING_BOT_FALLBACK_ENABLED: 'true',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
      expect(
        readBotFallbackEnabled({
          MATCHMAKING_BOT_FALLBACK_ENABLED: '1',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });
  });

  describe('readNoOpponentsTimeoutMs — KS-2197', () => {
    it('ENV пуст → дефолт 60000', () => {
      expect(readNoOpponentsTimeoutMs({} as NodeJS.ProcessEnv)).toBe(
        DEFAULT_NO_OPPONENTS_TIMEOUT_MS,
      );
    });

    it('ENV число → парсится', () => {
      expect(
        readNoOpponentsTimeoutMs({
          MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS: '120000',
        } as NodeJS.ProcessEnv),
      ).toBe(120_000);
    });

    it('ENV не число → дефолт', () => {
      expect(
        readNoOpponentsTimeoutMs({
          MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS: 'abc',
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_NO_OPPONENTS_TIMEOUT_MS);
    });

    it('ENV отрицательное / 0 → дефолт', () => {
      expect(
        readNoOpponentsTimeoutMs({
          MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS: '-1',
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_NO_OPPONENTS_TIMEOUT_MS);
      expect(
        readNoOpponentsTimeoutMs({
          MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS: '0',
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_NO_OPPONENTS_TIMEOUT_MS);
    });
  });

  describe('leaveQueue', () => {
    it('should remove user from queue', async () => {
      const entry = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrange.mockResolvedValue([entry]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(true);
      expect(redis.zrem).toHaveBeenCalledWith('matchmaking:blitz', entry);
    });

    it('should return false when user not in queue', async () => {
      redis.zrange.mockResolvedValue([]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(false);
    });

    it('should not remove other users from queue', async () => {
      const otherEntry = JSON.stringify({
        userId: opponentId,
        rating: 1500,
        timeInitialSec: 300,
        timeIncrementSec: 0,
      });

      redis.zrange.mockResolvedValue([otherEntry]);

      const result = await service.leaveQueue(userId, 'blitz');

      expect(result).toBe(false);
      expect(redis.zrem).not.toHaveBeenCalled();
    });
  });
});
