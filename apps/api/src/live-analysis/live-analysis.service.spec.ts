import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LiveAnalysisService } from './live-analysis.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

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
  async rpush(key: string, ...values: string[]): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    for (const v of values) arr.push(v);
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
  /**
   * Совместим с ioredis: `set(key, value)`, `set(key, value, 'EX', ttl)`,
   * `set(key, value, 'EX', ttl, 'NX')`. NX возвращает `null` если ключ
   * уже существует, `OK` если установлен.
   */
  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const hasNX = args.some((a) => String(a).toUpperCase() === 'NX');
    if (hasNX && this.kv.has(key)) return null;
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
      count: jest.Mock;
    };
  };
  let redis: FakeRedis;
  let metrics: jest.Mocked<Partial<MetricsService>>;

  beforeEach(async () => {
    prisma = {
      liveAnalysis: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    redis = new FakeRedis();
    metrics = {
      incLiveAnalysisActive: jest.fn(),
      decLiveAnalysisActive: jest.fn(),
      setLiveAnalysisActive: jest.fn(),
      incLiveAnalysisViewers: jest.fn(),
      decLiveAnalysisViewers: jest.fn(),
      incLiveAnalysisMoveAccepted: jest.fn(),
      incLiveAnalysisMoveIllegal: jest.fn(),
      incLiveAnalysisRateLimited: jest.fn(),
      incLiveAnalysisCleanupClosed: jest.fn(),
      incLiveAnalysisStatePatchAccepted: jest.fn(),
      incLiveAnalysisStatePatchRejected: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveAnalysisService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis as unknown as RedisService },
        { provide: MetricsService, useValue: metrics as unknown as MetricsService },
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

  // ─── KS-3734: token-bucket автора ─────────────────────────────────

  describe('applyMove — token-bucket', () => {
    it('блокирует 11-й ход подряд (burst 10)', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      // Серия легальных ходов; конкретные комбинации не важны — фиксим
      // позицию ручным sequence'ом: 5 ходов вперёд/назад королём белых
      // в специально подготовленном FEN. Проще: подставим FEN такой,
      // что любой ход одной фигуры легален. Используем King-only
      // позицию (нелегальна по FIDE, но chess.js парсит позиции с
      // одинокими королями).
      // Проще: имитируем moves строго pre-validated через
      // applyMove с реальной шахматной партией — она проходит ~5-6
      // легальных ходов. Возьмём короткую серию e2e4 e7e5 g1f3 g8f6...
      const sequence = ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'b1c3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'd7d6'];
      for (const uci of sequence) {
        await service.applyMove('s', 'u-1', uci);
      }
      // 11-й любой ход → token-bucket пустой, отказ.
      await expect(service.applyMove('s', 'u-1', 'a2a3')).rejects.toThrow(
        BadRequestException,
      );
      expect(metrics.incLiveAnalysisRateLimited).toHaveBeenCalledWith('author_moves');
    });
  });

  // ─── KS-3734: лимит зрителей на трансляцию ────────────────────────

  describe('tryAcquireViewerSlot', () => {
    beforeEach(() => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'active',
      });
    });

    it('возвращает count при наличии слотов', async () => {
      const n = await service.tryAcquireViewerSlot('s');
      expect(n).toBe(1);
      expect(metrics.incLiveAnalysisViewers).toHaveBeenCalled();
    });

    it('возвращает null при превышении capacity 1000', async () => {
      // Имитируем уже занятые 1000 слотов прямой записью в FakeRedis.
      await redis.set('live_analysis:la-1:viewers', '1000');
      const n = await service.tryAcquireViewerSlot('s');
      expect(n).toBeNull();
      expect(metrics.incLiveAnalysisRateLimited).toHaveBeenCalledWith('viewers_cap');
      // Откат INCR — счётчик опять 1000.
      const after = await redis.get('live_analysis:la-1:viewers');
      expect(after).toBe('1000');
    });
  });

  // ─── KS-3734: лимит IP-подключений ────────────────────────────────

  describe('tryAcquireIpSlot', () => {
    it('пускает первые 10 коннектов с IP', async () => {
      for (let i = 0; i < 10; i++) {
        const ok = await service.tryAcquireIpSlot('1.2.3.4');
        expect(ok).toBe(true);
      }
    });

    it('блокирует 11-й коннект и возвращает счётчик к 10', async () => {
      for (let i = 0; i < 10; i++) {
        await service.tryAcquireIpSlot('1.2.3.4');
      }
      const ok = await service.tryAcquireIpSlot('1.2.3.4');
      expect(ok).toBe(false);
      expect(metrics.incLiveAnalysisRateLimited).toHaveBeenCalledWith('ip_conns');
      // INCR откатился, счётчик 10
      const v = await redis.get('live-analysis:ip:1.2.3.4:conns');
      expect(v).toBe('10');
    });

    it('releaseIpSlot декрементирует счётчик', async () => {
      await service.tryAcquireIpSlot('5.6.7.8');
      await service.tryAcquireIpSlot('5.6.7.8');
      await service.releaseIpSlot('5.6.7.8');
      const v = await redis.get('live-analysis:ip:5.6.7.8:conns');
      expect(v).toBe('1');
    });
  });

  // ─── KS-3743: applyStatePatch ─────────────────────────────────────

  describe('applyStatePatch', () => {
    const activeMeta = {
      id: 'la-1',
      ownerId: 'u-1',
      status: 'active' as const,
      startingFen: null as string | null,
    };

    const tinyPgn = '1. e4 e5 2. Nf3 Nc6 *';

    beforeEach(() => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeMeta);
    });

    it('применяет валидный PGN: синхронизирует moves-list по main-line и пишет currentPgn в Redis', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', { pgn: tinyPgn });
      expect(snap.currentPgn).toBe(tinyPgn);
      expect(snap.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
      expect(snap.currentPly).toBe(4);
      // currentFen — позиция после 4 полуходов.
      expect(snap.currentFen).toContain('w');
      const moves = await redis.lrange('live_analysis:la-1:moves', 0, -1);
      expect(moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
      const state = await redis.hgetall('live_analysis:la-1:state');
      expect(state.currentPgn).toBe(tinyPgn);
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:sync',
        expect.stringContaining('"currentPgn"'),
      );
    });

    it('reconnect зрителя: getSyncSnapshot возвращает те же moves что и main-line PGN', async () => {
      // Применяем patch
      await service.applyStatePatch('s', 'u-1', { pgn: tinyPgn });
      // Эмулируем reconnect: getSyncSnapshot читает Redis заново.
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
      expect(snap.currentPgn).toBe(tinyPgn);
      expect(snap.currentPly).toBe(4);
    });

    it('игнорирует невалидный currentPly и берёт длину истории', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', {
        pgn: tinyPgn,
        currentPply: 999, // намеренно опечатка — это поле не существует, проверяем поведение по умолчанию
      } as any);
      expect(snap.currentPly).toBe(4);
    });

    it('поддерживает листание автором назад: currentPly < длины истории', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', {
        pgn: tinyPgn,
        currentPly: 2,
      });
      expect(snap.currentPly).toBe(2);
      // currentFen — после e4 e5 (ход белых, чёрный сыграл).
      expect(snap.currentFen).toContain('w');
    });

    it('rejects PGN с >256 KB', async () => {
      const huge = '[Event "x"]\n\n1. e4 e5 *\n' + 'A'.repeat(300_000);
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: huge }),
      ).rejects.toThrow(/pgn-too-large/);
      expect(prisma.liveAnalysis.update).not.toHaveBeenCalled();
    });

    it('rejects невалидный PGN', async () => {
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: '!!!garbage!!!' }),
      ).rejects.toThrow(/Invalid PGN|pgn/i);
    });

    it('rejects если не owner', async () => {
      await expect(
        service.applyStatePatch('s', 'NOT-u-1', { pgn: tinyPgn }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects если closed', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        ...activeMeta,
        status: 'closed',
      });
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: tinyPgn }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rate-limit: 11 patch-ей подряд → 11-й отклонён', async () => {
      for (let i = 0; i < 10; i++) {
        await service.applyStatePatch('s', 'u-1', { pgn: tinyPgn });
      }
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: tinyPgn }),
      ).rejects.toThrow(/Rate limit/);
    });

    it('инкрементит state_patches_total + bytes_sum на успешный patch', async () => {
      await service.applyStatePatch('s', 'u-1', { pgn: tinyPgn });
      expect(metrics.incLiveAnalysisStatePatchAccepted).toHaveBeenCalledWith(
        tinyPgn.length,
      );
    });

    it('инкрементит rejected_total{reason=pgn_too_large} при превышении 256 KB', async () => {
      const huge = '[Event "x"]\n\n1. e4 *\n' + 'A'.repeat(300_000);
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: huge }),
      ).rejects.toThrow();
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'pgn_too_large',
      );
    });

    it('инкрементит rejected_total{reason=invalid_pgn} при битом PGN', async () => {
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: '!!!garbage!!!' }),
      ).rejects.toThrow();
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'invalid_pgn',
      );
    });

    it('инкрементит rejected_total{reason=rate_limit} при срабатывании bucket', async () => {
      for (let i = 0; i < 10; i++) {
        await service.applyStatePatch('s', 'u-1', { pgn: tinyPgn });
      }
      await expect(
        service.applyStatePatch('s', 'u-1', { pgn: tinyPgn }),
      ).rejects.toThrow();
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'rate_limit',
      );
    });

    it('инкрементит rejected_total{reason=forbidden} если не владелец', async () => {
      await expect(
        service.applyStatePatch('s', 'NOT-u-1', { pgn: tinyPgn }),
      ).rejects.toThrow(ForbiddenException);
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'forbidden',
      );
    });

    it('publish payload включает currentPgn, moves и headers (если есть)', async () => {
      const pgnWithHeaders = '[White "Alice"]\n[Black "Bob"]\n\n1. e4 *';
      await service.applyStatePatch('s', 'u-1', {
        pgn: pgnWithHeaders,
        headers: { White: 'Alice', Black: 'Bob' },
      });
      const publishedCalls = (redis.publish as jest.Mock).mock.calls;
      const syncCall = publishedCalls.find((c) => c[0] === 'live-analysis:sync');
      expect(syncCall).toBeDefined();
      const payload = JSON.parse(syncCall![1]);
      expect(payload.currentPgn).toContain('Alice');
      expect(payload.moves).toEqual(['e2e4']);
      expect(payload.headers).toEqual(expect.objectContaining({ White: 'Alice' }));
    });
  });

  // ─── KS-3733: cleanup-job + Redis lock ────────────────────────────

  describe('runCleanupTick', () => {
    const cutoffNow = new Date('2026-06-06T12:30:00Z');

    it('закрывает active с lastActivityAt < NOW() - 30min и публикует closed', async () => {
      prisma.liveAnalysis.findMany.mockResolvedValueOnce([
        { id: 'la-1', slug: 'slug-1' },
        { id: 'la-2', slug: 'slug-2' },
      ]);
      const result = await service.runCleanupTick(cutoffNow);
      expect(result.locked).toBe(true);
      expect(result.scanned).toBe(2);
      expect(result.closed).toBe(2);
      // SELECT cutoff = now - 30 min
      const whereArg = prisma.liveAnalysis.findMany.mock.calls[0][0].where;
      const cutoffMs = whereArg.lastActivityAt.lt.getTime();
      expect(cutoffNow.getTime() - cutoffMs).toBe(30 * 60 * 1000);
      // Обновление статуса
      expect(prisma.liveAnalysis.update).toHaveBeenCalledTimes(2);
      expect(prisma.liveAnalysis.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'closed' }),
        }),
      );
      // Pub/sub closed { reason: 'inactivity' }
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:closed',
        expect.stringContaining('"reason":"inactivity"'),
      );
      // Метрики
      expect(metrics.incLiveAnalysisCleanupClosed).toHaveBeenCalledTimes(2);
    });

    it('второй параллельный тик не получает lock и делает no-op', async () => {
      // Первый — занял lock и не успел отпустить (имитация: руками
      // выставим lock-ключ).
      await redis.set('cleanup:live-analysis:lock', 'someone-else');
      prisma.liveAnalysis.findMany.mockResolvedValue([]);
      const result = await service.runCleanupTick(cutoffNow);
      expect(result.locked).toBe(false);
      expect(result.scanned).toBe(0);
      expect(prisma.liveAnalysis.findMany).not.toHaveBeenCalled();
    });

    it('освобождает lock по завершении', async () => {
      prisma.liveAnalysis.findMany.mockResolvedValue([]);
      await service.runCleanupTick(cutoffNow);
      const lock = await redis.get('cleanup:live-analysis:lock');
      expect(lock).toBeNull();
    });
  });
});
