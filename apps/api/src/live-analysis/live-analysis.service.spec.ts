import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LiveAnalysisService } from './live-analysis.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * KS-3732 / ADR-110 §2.9. Unit-тесты сервиса live-трансляции.
 *
 * Покрываем:
 *   - валидация UCI через chess.js (легальный/нелегальный);
 *   - проверка ownerId на applyMove/applyReset/closeBySlug;
 *   - slug-генерация (длина 10, URL-safe alphabet, retry на коллизии);
 *   - sync-snapshot (стартовая позиция + список ходов).
 *
 * Redis замокан in-memory мини-эмулятором: hash-set/list/incr/decr,
 * остальные операции (publish/expire/multi) — no-op chainable.
 */

type RedisHash = Record<string, string>;

class FakeRedis {
  private hashes = new Map<string, RedisHash>();
  private lists = new Map<string, string[]>();
  private kv = new Map<string, string>();

  publish = jest.fn(async () => 1);

  async hset(key: string, fields: RedisHash): Promise<number> {
    const h = this.hashes.get(key) ?? {};
    for (const [k, v] of Object.entries(fields)) h[k] = String(v);
    this.hashes.set(key, h);
    return Object.keys(fields).length;
  }
  async hgetall(key: string): Promise<RedisHash> {
    return { ...(this.hashes.get(key) ?? {}) };
  }
  async rpush(key: string, value: string): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    arr.push(value);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange(key: string, _from: number, _to: number): Promise<string[]> {
    return [...(this.lists.get(key) ?? [])];
  }
  async del(key: string): Promise<number> {
    const had = this.hashes.delete(key) || this.lists.delete(key) || this.kv.delete(key);
    return had ? 1 : 0;
  }
  async expire(_k: string, _t: number): Promise<number> {
    return 1;
  }
  async incr(key: string): Promise<number> {
    const n = Number(this.kv.get(key) ?? '0') + 1;
    this.kv.set(key, String(n));
    return n;
  }
  async decr(key: string): Promise<number> {
    const n = Number(this.kv.get(key) ?? '0') - 1;
    this.kv.set(key, String(n));
    return n;
  }
  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }

  /** Поддержка chainable multi() — складываем команды и применяем при exec(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  multi(): any {
    const calls: Array<() => Promise<unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = (method: string) => (...args: any[]) => {
      calls.push(() => self[method](...args));
      return chain;
    };
    chain.hset = wrap('hset');
    chain.rpush = wrap('rpush');
    chain.del = wrap('del');
    chain.expire = wrap('expire');
    chain.set = wrap('set');
    chain.exec = async () => {
      const out: unknown[] = [];
      for (const c of calls) out.push(await c());
      return out;
    };
    return chain;
  }
}

describe('LiveAnalysisService', () => {
  let service: LiveAnalysisService;
  let prisma: {
    liveAnalysis: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let redis: FakeRedis;

  beforeEach(async () => {
    prisma = {
      liveAnalysis: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    redis = new FakeRedis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveAnalysisService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis as unknown as RedisService },
      ],
    }).compile();
    service = module.get(LiveAnalysisService);
  });

  // ─── create ───────────────────────────────────────────────────────

  describe('create', () => {
    it('генерирует URL-safe slug длиной 10 и сохраняет state в Redis', async () => {
      prisma.liveAnalysis.create.mockResolvedValueOnce({ id: 'la-1' });
      prisma.liveAnalysis.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'la-1',
        slug: 'AbCdEfGhIj',
        ownerId: 'u-1',
        title: null,
        startingFen: null,
        status: 'active',
        createdAt: new Date('2026-06-06T00:00:00Z'),
        closedAt: null,
        owner: { username: 'alice' },
      });

      const resp = await service.create('u-1', {}, 'https://kingside.site');

      expect(resp.slug).toBe('AbCdEfGhIj');
      expect(resp.url).toBe('https://kingside.site/live/AbCdEfGhIj');
      expect(resp.currentPly).toBe(0);
      expect(resp.orientation).toBe('white');

      // slug, переданный в Prisma.create, — это nanoid(10) URL-safe
      const callArgs = prisma.liveAnalysis.create.mock.calls[0][0].data;
      expect(callArgs.slug).toMatch(/^[A-Za-z0-9]{10}$/);
      expect(callArgs.ownerId).toBe('u-1');
      // state в Redis заведён
      const state = await redis.hgetall('live_analysis:la-1:state');
      expect(state.currentFen).toContain('rnbqkbnr');
      expect(state.currentPly).toBe('0');
    });

    it('бракует невалидный starting FEN', async () => {
      await expect(
        service.create('u-1', { startingFen: 'garbage' }, 'https://k.s'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.liveAnalysis.create).not.toHaveBeenCalled();
    });

    it('retry при коллизии UNIQUE(slug)', async () => {
      const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
      prisma.liveAnalysis.create
        .mockRejectedValueOnce(p2002)
        .mockResolvedValueOnce({ id: 'la-2' });
      prisma.liveAnalysis.findUniqueOrThrow.mockResolvedValue({
        id: 'la-2',
        slug: 'XyZ1234567',
        ownerId: 'u-1',
        title: null,
        startingFen: null,
        status: 'active',
        createdAt: new Date(),
        closedAt: null,
        owner: { username: 'a' },
      });
      await service.create('u-1', {}, 'https://k.s');
      expect(prisma.liveAnalysis.create).toHaveBeenCalledTimes(2);
    });
  });

  // ─── applyMove: chess.js валидация + owner-check ──────────────────

  describe('applyMove', () => {
    const baseRow = {
      id: 'la-1',
      ownerId: 'u-1',
      status: 'active' as const,
      startingFen: null as string | null,
    };

    it('применяет легальный e2e4 и пишет в Redis', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      const ev = await service.applyMove('s', 'u-1', 'e2e4');
      expect(ev.uci).toBe('e2e4');
      expect(ev.ply).toBe(1);
      expect(ev.fen).toContain('PPPP');
      const moves = await redis.lrange('live_analysis:la-1:moves', 0, -1);
      expect(moves).toEqual(['e2e4']);
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:move',
        expect.stringContaining('e2e4'),
      );
    });

    it('кидает 400 на нелегальный UCI', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      await expect(service.applyMove('s', 'u-1', 'e2e5')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('кидает 400 на синтаксически невалидный UCI', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      await expect(service.applyMove('s', 'u-1', 'zzzz')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('кидает 403 если не owner', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      await expect(service.applyMove('s', 'NOT-u-1', 'e2e4')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('кидает 404 если slug closed', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        ...baseRow,
        status: 'closed',
      });
      await expect(service.applyMove('s', 'u-1', 'e2e4')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── closeBySlug ──────────────────────────────────────────────────

  describe('closeBySlug', () => {
    it('закрывает active и публикует событие', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      const res = await service.closeBySlug('s', 'u-1');
      expect(res.alreadyClosed).toBe(false);
      expect(prisma.liveAnalysis.update).toHaveBeenCalledWith({
        where: { id: 'la-1' },
        data: expect.objectContaining({ status: 'closed' }),
      });
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:closed',
        expect.stringContaining('"reason":"by_owner"'),
      );
    });

    it('идемпотентно при повторном закрытии', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'closed',
      });
      const res = await service.closeBySlug('s', 'u-1');
      expect(res.alreadyClosed).toBe(true);
      expect(prisma.liveAnalysis.update).not.toHaveBeenCalled();
    });

    it('кидает 403 если не owner', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      await expect(service.closeBySlug('s', 'NOT-u-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── getSyncSnapshot ──────────────────────────────────────────────

  describe('getSyncSnapshot', () => {
    it('возвращает стартовую позицию и пустой список ходов сразу после create', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      // state не инициализирован в FakeRedis для этого id — fallback на initial.
      const snap = await service.getSyncSnapshot('s');
      expect(snap.currentPly).toBe(0);
      expect(snap.moves).toEqual([]);
      expect(snap.currentFen).toContain('rnbqkbnr');
      expect(snap.orientation).toBe('white');
    });

    it('возвращает накопленный список ходов и текущий FEN', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      await service.applyMove('s', 'u-1', 'e2e4');
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      await service.applyMove('s', 'u-1', 'e7e5');

      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.moves).toEqual(['e2e4', 'e7e5']);
      expect(snap.currentPly).toBe(2);
    });

    it('404 если slug closed', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'closed',
        startingFen: null,
      });
      await expect(service.getSyncSnapshot('s')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── applyReset ───────────────────────────────────────────────────

  describe('applyReset', () => {
    it('очищает историю и эмитит sync', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      // сначала ход
      await service.applyMove('s', 'u-1', 'e2e4');
      // потом reset
      const snap = await service.applyReset('s', 'u-1');
      expect(snap.currentPly).toBe(0);
      expect(snap.moves).toEqual([]);
      const moves = await redis.lrange('live_analysis:la-1:moves', 0, -1);
      expect(moves).toEqual([]);
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:sync',
        expect.stringContaining('"currentPly":0'),
      );
    });

    it('кидает 403 если не owner', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      await expect(service.applyReset('s', 'NOT-u-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
