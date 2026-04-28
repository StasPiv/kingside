/**
 * KS-2104 — `FeatureFlagsService`: bootstrap, кэш TTL, инвалидация,
 * fallback на дефолты при ошибке БД.
 */
import { BadRequestException } from '@nestjs/common';
import {
  FeatureFlagsService,
  KNOWN_FEATURE_FLAGS,
} from './feature-flags.service';
import type { PrismaService } from '../prisma/prisma.service';

interface Row { key: string; value: boolean; updatedAt: Date }

function makePrisma(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let findManyError: Error | null = null;
  const prisma = {
    featureFlag: {
      findMany: jest.fn(async () => {
        if (findManyError) throw findManyError;
        return rows.map((r) => ({ ...r }));
      }),
      upsert: jest.fn(
        async (args: {
          where: { key: string };
          create: { key: string; value: boolean };
          update: { value?: boolean };
        }) => {
          const existing = rows.find((r) => r.key === args.where.key);
          if (!existing) {
            const row = { ...args.create, updatedAt: new Date() };
            rows.push(row);
            return row;
          }
          if (args.update.value !== undefined) existing.value = args.update.value;
          existing.updatedAt = new Date();
          return existing;
        },
      ),
    },
  } as unknown as PrismaService;
  return { prisma, rows, setFindManyError: (e: Error | null) => (findManyError = e) };
}

describe('FeatureFlagsService — KS-2104', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('onApplicationBootstrap сидит дефолты и греет кэш', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new FeatureFlagsService(prisma);
    await svc.onApplicationBootstrap();
    // Все ключи из whitelist оказались в БД с дефолтами.
    expect(rows.find((r) => r.key === 'lessonsEnabled')?.value).toBe(
      KNOWN_FEATURE_FLAGS.lessonsEnabled,
    );
    // Кэш горячий: следующий getFlags не делает SELECT.
    (prisma.featureFlag.findMany as jest.Mock).mockClear();
    const flags = await svc.getFlags();
    expect(flags.lessonsEnabled).toBe(true);
    expect(prisma.featureFlag.findMany).not.toHaveBeenCalled();
  });

  it('getFlags читает значение из БД, кэширует на 60s', async () => {
    const { prisma } = makePrisma([
      { key: 'lessonsEnabled', value: false, updatedAt: new Date() },
    ]);
    const svc = new FeatureFlagsService(prisma);

    const a = await svc.getFlags();
    expect(a.lessonsEnabled).toBe(false);

    // Второй вызов — из кэша (один SELECT суммарно).
    const b = await svc.getFlags();
    expect(b.lessonsEnabled).toBe(false);
    expect((prisma.featureFlag.findMany as jest.Mock).mock.calls.length).toBe(1);
  });

  it('TTL: после 60s+ кэш протухает, делается новый SELECT', async () => {
    const { prisma } = makePrisma([
      { key: 'lessonsEnabled', value: true, updatedAt: new Date() },
    ]);
    const svc = new FeatureFlagsService(prisma);

    await svc.getFlags();
    expect((prisma.featureFlag.findMany as jest.Mock).mock.calls.length).toBe(1);

    // Прошло 30s — ещё в кэше.
    jest.advanceTimersByTime(30_000);
    await svc.getFlags();
    expect((prisma.featureFlag.findMany as jest.Mock).mock.calls.length).toBe(1);

    // Прошло ещё 31s (всего 61s) — кэш протух.
    jest.advanceTimersByTime(31_000);
    await svc.getFlags();
    expect((prisma.featureFlag.findMany as jest.Mock).mock.calls.length).toBe(2);
  });

  it('setFlag апсертит в БД и инвалидирует кэш', async () => {
    const { prisma, rows } = makePrisma([
      { key: 'lessonsEnabled', value: true, updatedAt: new Date() },
    ]);
    const svc = new FeatureFlagsService(prisma);
    await svc.getFlags(); // прогреть кэш

    const before = (prisma.featureFlag.findMany as jest.Mock).mock.calls.length;
    await svc.setFlag('lessonsEnabled', false);
    expect(rows[0].value).toBe(false);

    // Следующий getFlags вынужден сделать SELECT (кэш сбросился).
    await svc.getFlags();
    expect(
      (prisma.featureFlag.findMany as jest.Mock).mock.calls.length,
    ).toBe(before + 1);
  });

  it('setFlag отвергает неизвестные ключи (защита от записи произвольных строк)', async () => {
    const { prisma } = makePrisma();
    const svc = new FeatureFlagsService(prisma);
    await expect(
      svc.setFlag('unknownKey' as never, true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('graceful fallback на дефолты при ошибке БД', async () => {
    const { prisma, setFindManyError } = makePrisma();
    const svc = new FeatureFlagsService(prisma);
    setFindManyError(new Error('connection refused'));

    const flags = await svc.getFlags();
    expect(flags).toEqual(KNOWN_FEATURE_FLAGS);
  });
});
