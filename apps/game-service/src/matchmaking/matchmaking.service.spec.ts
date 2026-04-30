jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import {
  DEFAULT_NO_OPPONENTS_TIMEOUT_MS,
  MATCHMAKER_NO_OPPONENTS_CHANNEL,
  MatchmakingService,
  readNoOpponentsTimeoutMs,
} from './matchmaking.service';

describe('MatchmakingService', () => {
  let service: MatchmakingService;
  let prisma: any;
  let redis: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const opponentId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
      },
    } as any;

    redis = {
      zadd: jest.fn().mockResolvedValue(1),
      zrange: jest.fn().mockResolvedValue([]),
      zrem: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      hset: jest.fn().mockResolvedValue(1),
    } as any;

    service = new MatchmakingService(redis, prisma);
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
   * KS-2197 — sweep пустой очереди.
   *
   * Цель: каждый тик `processQueue` (вызывается из `processAllQueues`
   * setInterval'ом по 2 сек) проверяет, есть ли в zset очереди записи,
   * которые висят дольше `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS`. Если
   * есть — удаляет их и публикует событие в pub/sub-канал. Подписчик
   * (`MatchmakingGateway`) дальше делает emit WS-event'а пользователю.
   *
   * Здесь тестируем сервис в изоляции: `redis.zrem` + `redis.publish`
   * вызваны корректно. Логика gateway покрыта отдельным spec'ом.
   */
  describe('processQueue — KS-2197 no_opponents sweep', () => {
    /** Доступ к private-методу для теста. */
    function callProcessQueue(s: MatchmakingService, cat: 'bullet' | 'blitz' | 'rapid' | 'classical') {
      return (s as unknown as { processQueue: (c: string) => Promise<void> }).processQueue(cat);
    }

    it('GWT-сценарий 1: одинокий, провисел >60s → zrem + publish с waitedMs', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const lonely = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 61_000, // 61 сек назад
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

    it('GWT-сценарий 2: пара спарилась до таймаута → publish НЕ вызван', async () => {
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

      // Подменим createMatchedGame, чтобы spec не зависел от prisma/redis
      // транзакций партии — нас интересует только sweep.
      const createMatchedGame = jest
        .spyOn(service as unknown as { createMatchedGame: () => Promise<void> }, 'createMatchedGame')
        .mockResolvedValue(undefined);

      await callProcessQueue(service, 'bullet');

      expect(createMatchedGame).toHaveBeenCalledTimes(1);
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('одиночка, не достиг таймаута (40s из 60s) → publish НЕ вызван', async () => {
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

    it('GWT-сценарий 3: повторный JOIN после таймаута → новый entry получает свежий joinedAt', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      // Первый JOIN — устаревший entry, sweep его выкидывает.
      const stale = JSON.stringify({
        userId,
        rating: 1500,
        timeInitialSec: 60,
        timeIncrementSec: 0,
        joinedAt: now - 70_000,
      });
      redis.zrange.mockResolvedValueOnce([stale]);
      await callProcessQueue(service, 'bullet');
      expect(redis.publish).toHaveBeenCalledTimes(1);

      // Имитируем повторный JOIN: пользователь снова в zset, но joinedAt
      // только что (`now`).
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: userId,
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      });
      jest.spyOn(Date, 'now').mockReturnValue(now);
      await service.joinQueue(userId, 60, 0);
      const freshEntry = redis.zadd.mock.calls.at(-1)![2];
      const freshParsed = JSON.parse(freshEntry as string);
      expect(freshParsed.joinedAt).toBe(now);

      // Сразу после повторного JOIN sweep НЕ публикует (пользователь
      // только что зашёл).
      redis.zrange.mockResolvedValueOnce([freshEntry]);
      redis.publish.mockClear();
      await callProcessQueue(service, 'bullet');
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('paired user не получает publish даже если давний joinedAt', async () => {
      // Edge-case: оба в очереди давно и спарились — публиковать
      // no_opponents для них нельзя, иначе клиент получит и FOUND, и
      // NO_OPPONENTS на одну сессию.
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
