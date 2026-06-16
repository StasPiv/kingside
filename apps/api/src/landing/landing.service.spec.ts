/**
 * KS-4264 / ADR-129 §5.4. Тесты LandingService — кэш + fallback.
 */

import { Test } from '@nestjs/testing';
import { LandingService } from './landing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

interface PrismaMock {
  game: { count: jest.Mock };
  puzzleAttempt: { count: jest.Mock };
  user: { count: jest.Mock };
}

interface RedisMock {
  get: jest.Mock;
  set: jest.Mock;
}

async function setup(opts: {
  redisGet?: () => Promise<string | null>;
  redisSet?: () => Promise<unknown>;
  game?: number | Error;
  puzzleAttempt?: number | Error;
  userCounts?: Array<number | Error>;
}): Promise<{
  service: LandingService;
  prisma: PrismaMock;
  redis: RedisMock;
}> {
  const userCounts = opts.userCounts ?? [];
  let userCallIdx = 0;

  const prisma: PrismaMock = {
    game: {
      count: jest.fn(async (args: unknown) => {
        // Без args → totalGames; с status=active → gamesInProgress.
        const where = (args as { where?: { status?: string } } | undefined)?.where;
        if (where?.status === 'active') {
          if (opts.game instanceof Error) throw opts.game;
          return typeof opts.game === 'number' ? opts.game : 7;
        }
        if (opts.game instanceof Error) throw opts.game;
        return typeof opts.game === 'number' ? opts.game : 1000;
      }),
    },
    puzzleAttempt: {
      count: jest.fn(async () => {
        if (opts.puzzleAttempt instanceof Error) throw opts.puzzleAttempt;
        return typeof opts.puzzleAttempt === 'number' ? opts.puzzleAttempt : 500;
      }),
    },
    user: {
      count: jest.fn(async () => {
        const v = userCounts[userCallIdx++];
        if (v === undefined) return 10;
        if (v instanceof Error) throw v;
        return v;
      }),
    },
  };

  const redis: RedisMock = {
    get: jest.fn(opts.redisGet ?? (async () => null)),
    set: jest.fn(opts.redisSet ?? (async () => 'OK')),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      LandingService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();

  return { service: moduleRef.get(LandingService), prisma, redis };
}

describe('LandingService.getStats', () => {
  it('cache hit: вернёт распарсенный JSON из Redis, БД не дёргается', async () => {
    const cached = {
      totalGames: 9999,
      totalPuzzlesSolved: 1234,
      registeredUsers: 50,
      onlineNow: 10,
      gamesInProgress: 3,
    };
    const { service, prisma } = await setup({
      redisGet: async () => JSON.stringify(cached),
    });
    expect(await service.getStats()).toEqual(cached);
    expect(prisma.game.count).not.toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('cache miss: читает БД и кладёт в Redis с TTL 60', async () => {
    const { service, redis } = await setup({
      // registeredUsers, online-real, online-bots
      userCounts: [42, 5, 2],
      game: 123,
      puzzleAttempt: 77,
    });
    // Хотя prisma.game.count вызывается дважды (без args + active),
    // оба раза вернут 123 (для простоты теста).
    const r = await service.getStats();
    expect(r).toEqual({
      totalGames: 123,
      totalPuzzlesSolved: 77,
      registeredUsers: 42,
      onlineNow: 7, // 5 real + 2 bots
      gamesInProgress: 123,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'cache:landing:stats',
      JSON.stringify(r),
      'EX',
      60,
    );
  });

  it('Redis.get падает → fallback на БД, не падаем', async () => {
    const { service, redis } = await setup({
      redisGet: async () => {
        throw new Error('redis down');
      },
      userCounts: [10, 3, 1],
    });
    const r = await service.getStats();
    expect(r.registeredUsers).toBe(10);
    expect(r.onlineNow).toBe(4);
    // set попытается записать — это тоже может упасть, но getStats
    // не должен падать.
    expect(redis.get).toHaveBeenCalled();
  });

  it('Redis.set падает после fallback → возвращает данные, не падает', async () => {
    const { service } = await setup({
      redisGet: async () => null,
      redisSet: async () => {
        throw new Error('redis down');
      },
      userCounts: [1, 1, 0],
    });
    const r = await service.getStats();
    expect(r.onlineNow).toBe(1);
  });

  it('Один counter БД падает → этот null, остальные есть', async () => {
    const { service } = await setup({
      userCounts: [
        20, // registeredUsers
        new Error('users.count failed'), // online-real падает
        1, // online-bots
      ],
      game: 555,
      puzzleAttempt: 88,
    });
    const r = await service.getStats();
    expect(r.registeredUsers).toBe(20);
    expect(r.onlineNow).toBeNull();
    expect(r.totalGames).toBe(555);
    expect(r.gamesInProgress).toBe(555);
    expect(r.totalPuzzlesSolved).toBe(88);
  });

  it('кэш с битым JSON → fallback на БД, не падает', async () => {
    const { service } = await setup({
      redisGet: async () => '{ broken json',
      userCounts: [1, 0, 0],
    });
    const r = await service.getStats();
    expect(r.registeredUsers).toBe(1);
    expect(r.onlineNow).toBe(0);
  });
});
