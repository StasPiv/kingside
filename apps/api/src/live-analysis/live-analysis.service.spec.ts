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
  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let removed = 0;
    for (const f of fields) {
      if (f in h) {
        delete h[f];
        removed += 1;
      }
    }
    return removed;
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
    chain.hdel = wrap('hdel');
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
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    analysis: {
      findUnique: jest.Mock;
    };
    lecture: {
      updateMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    lectureRecording: {
      create: jest.Mock;
    };
  };
  let redis: FakeRedis;
  let metrics: jest.Mocked<Partial<MetricsService>>;

  beforeEach(async () => {
    prisma = {
      liveAnalysis: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      analysis: {
        // KS-3759: по умолчанию владелец совпадает с тем, кому
        // принадлежит анализ — тестам без явного mock-а это позволяет
        // не падать на проверке владельца.
        findUnique: jest.fn().mockResolvedValue({ id: 'a-1', userId: 'u-1' }),
      },
      lecture: {
        // KS-3785: closeBySlug/runCleanupTick зовут updateMany на
        // lectures для проставления endedAt. По умолчанию нет
        // связанных лекций (count=0).
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // KS-3791: getLectureBinding зовёт findFirst. По умолчанию
        // лекции под трансляцией нет — recordLectureEvent no-op.
        findFirst: jest.fn().mockResolvedValue(null),
        // KS-3792: финализатор делает UPDATE Lecture (status,
        // recordingId/endedAt). По умолчанию резолвится пустым объектом.
        update: jest.fn().mockResolvedValue({}),
      },
      lectureRecording: {
        create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
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
      incLiveAnalysisCreated: jest.fn(),
      setLiveAnalysisZombieClosedAtMigration: jest.fn(),
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

      const resp = await service.create(
        'u-1',
        // KS-3758: analysisId стал обязательным; реальная валидация
        // владельца анализа подключится в KS-3759.
        { analysisId: 'a-1' },
        'https://kingside.site',
      );

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
        service.create(
          'u-1',
          { analysisId: 'a-1', startingFen: 'garbage' },
          'https://k.s',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.liveAnalysis.create).not.toHaveBeenCalled();
    });

    // ─── KS-3759: ownership Analysis ───────────────────────────────

    it('404 если Analysis не найден', async () => {
      prisma.analysis.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u-1', { analysisId: 'a-MISSING' }, 'https://k.s'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.liveAnalysis.create).not.toHaveBeenCalled();
    });

    it('403 если ownerId != Analysis.userId', async () => {
      prisma.analysis.findUnique.mockResolvedValueOnce({
        id: 'a-1',
        userId: 'OTHER-user',
      });
      await expect(
        service.create('u-1', { analysisId: 'a-1' }, 'https://k.s'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.liveAnalysis.create).not.toHaveBeenCalled();
    });

    // ─── KS-3759: идемпотентность ──────────────────────────────────

    it('возвращает existing active без INSERT (идемпотентность)', async () => {
      prisma.liveAnalysis.findFirst.mockResolvedValueOnce({
        id: 'la-existing',
        slug: 'EXIST00000',
        ownerId: 'u-1',
        title: null,
        startingFen: null,
        status: 'active',
        createdAt: new Date('2026-06-06T00:00:00Z'),
        closedAt: null,
        analysisId: 'a-1',
        owner: { username: 'alice' },
      });
      const resp = await service.create(
        'u-1',
        { analysisId: 'a-1' },
        'https://kingside.site',
      );
      expect(resp.slug).toBe('EXIST00000');
      expect(resp.analysisId).toBe('a-1');
      expect(prisma.liveAnalysis.create).not.toHaveBeenCalled();
    });

    // ─── KS-3759: P2002 race на partial UNIQUE ─────────────────────

    it('concurrent POST: на P2002 (partial UNIQUE) возвращает existing', async () => {
      // findFirst в начале — null (ещё нет). После INSERT-failure
      // findFirst возвращает запись, созданную параллельным процессом.
      prisma.liveAnalysis.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'la-race',
          slug: 'RACEWINNER',
          ownerId: 'u-1',
          title: null,
          startingFen: null,
          status: 'active',
          createdAt: new Date(),
          closedAt: null,
          analysisId: 'a-1',
          owner: { username: 'alice' },
        });
      // P2002 на partial UNIQUE — meta.target указывает на индекс
      // (owner_id, analysis_id) ИЛИ Prisma даёт indexName.
      const p2002 = Object.assign(new Error('unique'), {
        code: 'P2002',
        meta: { target: ['owner_id', 'analysis_id'] },
      });
      prisma.liveAnalysis.create.mockRejectedValueOnce(p2002);
      const resp = await service.create(
        'u-1',
        { analysisId: 'a-1' },
        'https://k.s',
      );
      expect(resp.slug).toBe('RACEWINNER');
    });

    it('retry при коллизии UNIQUE(slug)', async () => {
      // meta.target указывает на slug — это и есть сигнал retry.
      const p2002 = Object.assign(new Error('unique'), {
        code: 'P2002',
        meta: { target: ['slug'] },
      });
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
      await service.create('u-1', { analysisId: 'a-1' }, 'https://k.s');
      expect(prisma.liveAnalysis.create).toHaveBeenCalledTimes(2);
    });
  });

  // ─── KS-3759: findActiveByAnalysisId ───────────────────────────────

  describe('findActiveByAnalysisId', () => {
    it('возвращает активную трансляцию при наличии', async () => {
      prisma.liveAnalysis.findFirst.mockResolvedValueOnce({
        id: 'la-99',
        slug: 'ACTIVE0000',
        ownerId: 'u-1',
        title: 'Live',
        startingFen: null,
        status: 'active',
        createdAt: new Date(),
        closedAt: null,
        analysisId: 'a-1',
        owner: { username: 'alice' },
      });
      const resp = await service.findActiveByAnalysisId(
        'u-1',
        'a-1',
        'https://k.s',
      );
      expect(resp).not.toBeNull();
      expect(resp!.slug).toBe('ACTIVE0000');
      expect(resp!.analysisId).toBe('a-1');
      // findFirst фильтрует по ownerId, analysisId, status='active'.
      const args = prisma.liveAnalysis.findFirst.mock.calls[0][0];
      expect(args.where).toEqual(
        expect.objectContaining({ ownerId: 'u-1', analysisId: 'a-1', status: 'active' }),
      );
    });

    it('возвращает null если нет active', async () => {
      prisma.liveAnalysis.findFirst.mockResolvedValueOnce(null);
      const resp = await service.findActiveByAnalysisId(
        'u-1',
        'a-1',
        'https://k.s',
      );
      expect(resp).toBeNull();
    });
  });

  // ─── applyMove (KS-3780+: ретранслятор, без chess.js валидации) ───

  describe('applyMove', () => {
    const baseRow = {
      id: 'la-1',
      ownerId: 'u-1',
      status: 'active' as const,
      startingFen: null as string | null,
    };

    it('публикует MoveEvent с UCI и ply, без вычисления FEN на backend', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      const ev = await service.applyMove('s', 'u-1', 'e2e4');
      expect(ev.uci).toBe('e2e4');
      expect(ev.ply).toBe(1);
      // KS-3780+: backend больше не вычисляет FEN, поле отсутствует
      // в payload (тип сделал его опциональным).
      expect(ev.fen).toBeUndefined();
      const moves = await redis.lrange('live_analysis:la-1:moves', 0, -1);
      expect(moves).toEqual(['e2e4']);
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:move',
        expect.stringContaining('e2e4'),
      );
    });

    it('принимает любой UCI без шахматной валидации (KS-3780+)', async () => {
      // Нелегальный по правилам шахмат UCI (e2e5 — двойной шаг через
      // занятую клетку, zzzz — несуществующие клетки) уже не валидируется
      // backend'ом. Источником истины является tree от автора.
      prisma.liveAnalysis.findUnique.mockResolvedValue(baseRow);
      const ev1 = await service.applyMove('s', 'u-1', 'e2e5');
      expect(ev1.uci).toBe('e2e5');
      const ev2 = await service.applyMove('s', 'u-1', 'zzzz');
      expect(ev2.uci).toBe('zzzz');
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

    // ─── KS-3785 / ADR-113: хук endedAt у связанной лекции ───────────

    it('KS-3785: проставляет endedAt у связанной live-лекции', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      prisma.lecture.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.closeBySlug('s', 'u-1');
      expect(prisma.lecture.updateMany).toHaveBeenCalledWith({
        where: { liveAnalysisId: 'la-1', status: 'live' },
        // KS-3887: вместе с endedAt принудительно ставится recorded —
        // страховка от рассинхронизации Lecture/LiveAnalysis.
        data: { endedAt: expect.any(Date), status: 'recorded' },
      });
    });

    it('KS-3785: трансляция без связанной лекции — count=0, успешно', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      // По умолчанию prisma.lecture.updateMany возвращает count=0.
      const res = await service.closeBySlug('s', 'u-1');
      expect(res.alreadyClosed).toBe(false);
      expect(prisma.lecture.updateMany).toHaveBeenCalledWith({
        where: { liveAnalysisId: 'la-1', status: 'live' },
        // KS-3887: вместе с endedAt принудительно ставится recorded —
        // страховка от рассинхронизации Lecture/LiveAnalysis.
        data: { endedAt: expect.any(Date), status: 'recorded' },
      });
    });

    it('KS-3785: ошибка updateMany не валит closeBySlug', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      prisma.lecture.updateMany.mockRejectedValueOnce(new Error('boom'));
      const res = await service.closeBySlug('s', 'u-1');
      expect(res.alreadyClosed).toBe(false);
      // closeBySlug всё равно publish'нул событие.
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:closed',
        expect.stringContaining('"reason":"by_owner"'),
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
      expect(snap.startingFen).toContain('rnbqkbnr');
      expect(snap.orientation).toBe('white');
      // KS-3780: до первого state-patch tree отсутствует.
      expect(snap.tree).toBeUndefined();
    });

    it('KS-3780: после state-patch отдаёт tree', async () => {
      // Подготовка: тестовый владелец active.
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
        startingFen: null,
      });
      await service.applyStatePatch('s', 'u-1', {
        tree: '{"history":[{"uci":"e2e4"}]}',
      });
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.tree).toBe('{"history":[{"uci":"e2e4"}]}');
    });

    it('404 если slug closed', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'closed',
        startingFen: null,
      });
      await expect(service.getSyncSnapshot('s')).rejects.toThrow(NotFoundException);
    });

    it('KS-3902: для трансляции без привязки к лекции lectureDisabledTools отсутствует', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      // По дефолту prisma.lecture.findFirst → null (нет привязки).
      const snap = await service.getSyncSnapshot('s');
      expect(snap.lectureDisabledTools).toBeUndefined();
    });

    it('KS-3902: для привязанной лекции lectureDisabledTools передаётся в snapshot', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      prisma.lecture.findFirst.mockResolvedValueOnce({
        disabledTools: ['engine', 'book'],
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.lectureDisabledTools).toEqual(['engine', 'book']);
      expect(prisma.lecture.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { liveAnalysisId: 'la-1' },
        }),
      );
    });

    it('KS-3902: лекция привязана, но disabledTools=[] → пустой массив в snapshot', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      prisma.lecture.findFirst.mockResolvedValueOnce({
        disabledTools: [],
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.lectureDisabledTools).toEqual([]);
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
      const moves = await redis.lrange('live_analysis:la-1:moves', 0, -1);
      expect(moves).toEqual([]);
      // KS-3780: snapshot после reset содержит только slug,
      // startingFen и orientation; tree сбрасывается до следующего
      // state-patch.
      expect(snap.startingFen).toContain('rnbqkbnr');
      expect(snap.tree).toBeUndefined();
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:sync',
        expect.stringContaining('"startingFen"'),
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

    // KS-3780: tree — это непрозрачная строка (JSON-сериализованное
    // дерево фронта). Backend не парсит её, так что в тестах можно
    // использовать любую строку.
    const tinyTree = '{"history":[{"uci":"e2e4"},{"uci":"e7e5"}]}';

    beforeEach(() => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeMeta);
    });

    it('KS-3780: пишет tree в Redis state hash и в snapshot', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      expect(snap.tree).toBe(tinyTree);
      const state = await redis.hgetall('live_analysis:la-1:state');
      expect(state.tree).toBe(tinyTree);
      expect(redis.publish).toHaveBeenCalledWith(
        'live-analysis:sync',
        expect.stringContaining('"tree"'),
      );
    });

    it('KS-3780: reconnect зрителя: getSyncSnapshot возвращает тот же tree', async () => {
      await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-1',
        status: 'active',
        startingFen: null,
      });
      const snap = await service.getSyncSnapshot('s');
      expect(snap.tree).toBe(tinyTree);
    });

    it('KS-3780: snapshot больше НЕ содержит moves[], currentPgn, currentFen, currentPly, headers', async () => {
      await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      const publishedCalls = (redis.publish as jest.Mock).mock.calls;
      const syncCall = publishedCalls.find((c) => c[0] === 'live-analysis:sync');
      const payload = JSON.parse(syncCall![1]);
      expect(payload.moves).toBeUndefined();
      expect(payload.currentPgn).toBeUndefined();
      expect(payload.currentFen).toBeUndefined();
      expect(payload.currentPly).toBeUndefined();
      expect(payload.headers).toBeUndefined();
    });

    it('rejects tree с >256 KB', async () => {
      const huge = 'A'.repeat(300_000);
      await expect(
        service.applyStatePatch('s', 'u-1', { tree: huge }),
      ).rejects.toThrow(/tree-too-large/);
      expect(prisma.liveAnalysis.update).not.toHaveBeenCalled();
    });

    it('rejects если не owner', async () => {
      await expect(
        service.applyStatePatch('s', 'NOT-u-1', { tree: tinyTree }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects если closed', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        ...activeMeta,
        status: 'closed',
      });
      await expect(
        service.applyStatePatch('s', 'u-1', { tree: tinyTree }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rate-limit: 11 patch-ей подряд → 11-й отклонён', async () => {
      for (let i = 0; i < 10; i++) {
        await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      }
      await expect(
        service.applyStatePatch('s', 'u-1', { tree: tinyTree }),
      ).rejects.toThrow(/Rate limit/);
    });

    it('инкрементит state_patches_total + bytes_sum на успешный patch', async () => {
      await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      expect(metrics.incLiveAnalysisStatePatchAccepted).toHaveBeenCalledWith(
        tinyTree.length,
      );
    });

    it('KS-3780: инкрементит rejected_total{reason=tree_too_large} при превышении 256 KB', async () => {
      const huge = 'A'.repeat(300_000);
      await expect(
        service.applyStatePatch('s', 'u-1', { tree: huge }),
      ).rejects.toThrow();
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'tree_too_large',
      );
    });

    it('инкрементит rejected_total{reason=rate_limit} при срабатывании bucket', async () => {
      for (let i = 0; i < 10; i++) {
        await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      }
      await expect(
        service.applyStatePatch('s', 'u-1', { tree: tinyTree }),
      ).rejects.toThrow();
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'rate_limit',
      );
    });

    it('инкрементит rejected_total{reason=forbidden} если не владелец', async () => {
      await expect(
        service.applyStatePatch('s', 'NOT-u-1', { tree: tinyTree }),
      ).rejects.toThrow(ForbiddenException);
      expect(metrics.incLiveAnalysisStatePatchRejected).toHaveBeenCalledWith(
        'forbidden',
      );
    });

    it('KS-3775: пробрасывает currentGlobalIndex в snapshot и Redis', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', {
        tree: tinyTree,
        currentGlobalIndex: 7,
      });
      expect(snap.currentGlobalIndex).toBe(7);
      const state = await redis.hgetall('live_analysis:la-1:state');
      expect(state.currentGlobalIndex).toBe('7');
      const publishedCalls = (redis.publish as jest.Mock).mock.calls;
      const syncCall = publishedCalls.find((c) => c[0] === 'live-analysis:sync');
      const payload = JSON.parse(syncCall![1]);
      expect(payload.currentGlobalIndex).toBe(7);
    });

    it('KS-3775: без currentGlobalIndex поле не появляется в snapshot', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', { tree: tinyTree });
      expect(snap.currentGlobalIndex).toBeUndefined();
    });

    it('KS-3775: невалидные значения currentGlobalIndex игнорируются', async () => {
      const snap = await service.applyStatePatch('s', 'u-1', {
        tree: tinyTree,
        currentGlobalIndex: -3,
      });
      expect(snap.currentGlobalIndex).toBeUndefined();
      const snap2 = await service.applyStatePatch('s', 'u-1', {
        tree: tinyTree,
        currentGlobalIndex: 1.5,
      });
      expect(snap2.currentGlobalIndex).toBeUndefined();
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

  // ─── KS-3762 / ADR-112: binding metrics ───────────────────────────

  describe('metrics: created_total{with_analysis_id} + zombie gauge', () => {
    it('create инкрементит created_total с with_analysis_id=true', async () => {
      prisma.liveAnalysis.create.mockResolvedValueOnce({ id: 'la-1' });
      prisma.liveAnalysis.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'la-1',
        slug: 'SLUG000000',
        ownerId: 'u-1',
        title: null,
        startingFen: null,
        status: 'active',
        createdAt: new Date(),
        closedAt: null,
        analysisId: 'a-1',
        owner: { username: 'alice' },
      });
      await service.create(
        'u-1',
        { analysisId: 'a-1' },
        'https://kingside.site',
      );
      expect(metrics.incLiveAnalysisCreated).toHaveBeenCalledWith(true);
    });

    it('create НЕ инкрементит created_total при идемпотентном возврате existing', async () => {
      prisma.liveAnalysis.findFirst.mockResolvedValueOnce({
        id: 'la-existing',
        slug: 'EXIST00000',
        ownerId: 'u-1',
        title: null,
        startingFen: null,
        status: 'active',
        createdAt: new Date(),
        closedAt: null,
        analysisId: 'a-1',
        owner: { username: 'alice' },
      });
      await service.create('u-1', { analysisId: 'a-1' }, 'https://k.s');
      expect(metrics.incLiveAnalysisCreated).not.toHaveBeenCalled();
    });

    it('onModuleInit считает зомби из PG и проставляет gauge', async () => {
      prisma.liveAnalysis.count.mockResolvedValueOnce(7);
      await service.onModuleInit();
      // фильтр: status='closed' AND analysisId IS NULL
      const args = prisma.liveAnalysis.count.mock.calls[0][0];
      expect(args.where).toEqual({ status: 'closed', analysisId: null });
      expect(metrics.setLiveAnalysisZombieClosedAtMigration).toHaveBeenCalledWith(7);
    });

    it('onModuleInit не падает при ошибке COUNT', async () => {
      prisma.liveAnalysis.count.mockRejectedValueOnce(new Error('boom'));
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(metrics.setLiveAnalysisZombieClosedAtMigration).not.toHaveBeenCalled();
    });
  });

  // ─── KS-3791 / ADR-113 §2.3: recorder событий в Redis ─────────────

  describe('KS-3791: recordLectureEvent через RPUSH', () => {
    const activeRow = {
      id: 'la-1',
      ownerId: 'u-1',
      status: 'active' as const,
      startingFen: null as string | null,
    };

    /**
     * Прочитать длину списка lecture_recording:<id>:events через
     * FakeRedis (внутри он держит lists.get(key)).
     */
    function readRecordedEvents(liveAnalysisId: string): string[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lists = (redis as any).lists as Map<string, string[]>;
      return lists.get(`lecture_recording:${liveAnalysisId}:events`) ?? [];
    }

    it('пишет событие move при applyMove если есть связанная live-лекция', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      prisma.lecture.findFirst.mockResolvedValueOnce({
        id: 'l-1',
        startedAt: new Date(Date.now() - 1234),
      });
      await service.applyMove('s', 'u-1', 'e2e4');
      const recorded = readRecordedEvents('la-1');
      expect(recorded).toHaveLength(1);
      const event = JSON.parse(recorded[0]);
      expect(event.type).toBe('move');
      expect(event.payload).toEqual({ uci: 'e2e4', ply: 1 });
      expect(event.t).toBeGreaterThanOrEqual(0);
    });

    it('кеширует биндинг: повторный applyMove не делает второй findFirst', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      prisma.lecture.findFirst.mockResolvedValueOnce({
        id: 'l-1',
        startedAt: new Date(Date.now() - 100),
      });
      await service.applyMove('s', 'u-1', 'e2e4');
      await service.applyMove('s', 'u-1', 'e2e5');
      expect(prisma.lecture.findFirst).toHaveBeenCalledTimes(1);
    });

    it('кеширует "лекции нет" — второй ход не дёргает PG повторно', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      // findFirst по умолчанию возвращает null — лекции нет.
      await service.applyMove('s', 'u-1', 'e2e4');
      await service.applyMove('s', 'u-1', 'e2e5');
      expect(prisma.lecture.findFirst).toHaveBeenCalledTimes(1);
      expect(readRecordedEvents('la-1')).toEqual([]);
    });

    it('пишет событие state-patch при applyStatePatch', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      prisma.lecture.findFirst.mockResolvedValueOnce({
        id: 'l-1',
        startedAt: new Date(Date.now() - 500),
      });
      await service.applyStatePatch('s', 'u-1', {
        tree: '{"history":[{"uci":"e2e4"}]}',
        currentGlobalIndex: 1,
      });
      const recorded = readRecordedEvents('la-1');
      expect(recorded).toHaveLength(1);
      const event = JSON.parse(recorded[0]);
      expect(event.type).toBe('state-patch');
      expect(event.payload.tree).toBe('{"history":[{"uci":"e2e4"}]}');
      expect(event.payload.currentGlobalIndex).toBe(1);
      expect(event.payload.orientation).toBe('white');
    });

    it('пишет событие reset при applyReset', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      prisma.lecture.findFirst.mockResolvedValueOnce({
        id: 'l-1',
        startedAt: new Date(Date.now() - 100),
      });
      await service.applyReset('s', 'u-1');
      const recorded = readRecordedEvents('la-1');
      const types = recorded.map((s) => JSON.parse(s).type);
      expect(types).toContain('reset');
    });

    it('пишет событие closed при closeBySlug и финализирует запись', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      prisma.lecture.findFirst.mockResolvedValue({
        id: 'l-1',
        startedAt: new Date(Date.now() - 100),
      });
      await service.closeBySlug('s', 'u-1');
      // KS-3792: после finalizer events list очищается. Проверяем,
      // что в INSERT LectureRecording.events попало событие 'closed'.
      expect(prisma.lectureRecording.create).toHaveBeenCalledTimes(1);
      const args = prisma.lectureRecording.create.mock.calls[0][0].data;
      const types = (args.events as Array<{ type: string }>).map((e) => e.type);
      expect(types).toContain('closed');
    });

    it('ошибка findFirst не валит applyMove — событие просто не пишется', async () => {
      prisma.liveAnalysis.findUnique.mockResolvedValue(activeRow);
      prisma.lecture.findFirst.mockRejectedValueOnce(new Error('boom'));
      const ev = await service.applyMove('s', 'u-1', 'e2e4');
      expect(ev.uci).toBe('e2e4');
      expect(readRecordedEvents('la-1')).toEqual([]);
    });
  });

  // ─── KS-3792 / ADR-113 §2.3: finalizer записи лекции ──────────────

  describe('KS-3792: finalizeLectureRecording через closeBySlug', () => {
    /** Положить «вручную» события в FakeRedis (как будто recorder уже писал). */
    function seedEvents(liveAnalysisId: string, events: unknown[]): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lists = (redis as any).lists as Map<string, string[]>;
      lists.set(
        `lecture_recording:${liveAnalysisId}:events`,
        events.map((e) => JSON.stringify(e)),
      );
    }

    /** Положить state hash чтобы readRedisState вернул startingFen/orientation. */
    function seedStateHash(
      liveAnalysisId: string,
      startingFen: string,
      orientation: string,
    ): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hashes = (redis as any).hashes as Map<string, Record<string, string>>;
      hashes.set(`live_analysis:${liveAnalysisId}:state`, {
        startingFen,
        currentFen: startingFen,
        currentPly: '0',
        orientation,
      });
    }

    /** Получить ключ списка записи — `null` если уже удалён DEL'ом. */
    function readEventListKey(liveAnalysisId: string): string[] | undefined {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lists = (redis as any).lists as Map<string, string[]>;
      return lists.get(`lecture_recording:${liveAnalysisId}:events`);
    }

    beforeEach(() => {
      prisma.liveAnalysis.findUnique.mockResolvedValue({
        id: 'la-1',
        ownerId: 'u-1',
        status: 'active',
      });
      prisma.lecture.findFirst.mockResolvedValue({
        id: 'l-1',
        startedAt: new Date(Date.now() - 60_000),
      });
    });

    it('нормальное закрытие: INSERT LectureRecording, UPDATE recorded, DEL events', async () => {
      seedStateHash('la-1', 'rnbqkbnr/...', 'white');
      seedEvents('la-1', [
        { t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } },
        { t: 500, type: 'move', payload: { uci: 'e7e5', ply: 2 } },
        { t: 1200, type: 'move', payload: { uci: 'g1f3', ply: 3 } },
      ]);
      await service.closeBySlug('s', 'u-1');
      expect(prisma.lectureRecording.create).toHaveBeenCalledTimes(1);
      const args = prisma.lectureRecording.create.mock.calls[0][0].data;
      expect(args.lectureId).toBe('l-1');
      // 3 seeded + 1 'closed' от recordLectureEvent в closeBySlug.
      expect(args.eventCount).toBeGreaterThanOrEqual(3);
      // durationMs = t последнего события; recordLectureEvent('closed')
      // добавляет своё событие с t≈Date.now()-startedAt ≥ 1200.
      expect(args.durationMs).toBeGreaterThanOrEqual(1200);
      expect(args.truncated).toBe(false);
      expect(args.startingFen).toBe('rnbqkbnr/...');
      expect(args.orientation).toBe('white');
      // UPDATE Lecture: status='recorded', recordingId=rec-1.
      expect(prisma.lecture.update).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        data: expect.objectContaining({
          status: 'recorded',
          recordingId: 'rec-1',
        }),
      });
      // events ключ удалён.
      expect(readEventListKey('la-1')).toBeUndefined();
    });

    it('пустая запись (0 событий): Lecture → cancelled, без LectureRecording', async () => {
      // Сценарий: recordLectureEvent не сработал (например, биндинг не
      // нашёлся в первый раз), кеш сбрасывается, и finalizer находит
      // лекцию — но events list пуст, поэтому cancelled без INSERT.
      seedStateHash('la-1', 'rnbqkbnr/...', 'white');
      prisma.lecture.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'l-1',
          startedAt: new Date(Date.now() - 60_000),
        });
      // Сбрасываем кеш биндинга между recordLectureEvent и finalizer
      // через монки-патч getLectureBinding: первая её попытка положит
      // null в кеш — после этого вручную очищаем.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cache = (service as any).lectureBindingCache as Map<string, unknown>;
      // Перехватываем recordLectureEvent — он первым вызовет findFirst
      // и положит null в кеш; после его завершения cache.clear().
      const origRecord = (service as unknown as {
        recordLectureEvent: (a: string, b: string, c: unknown) => Promise<void>;
      }).recordLectureEvent.bind(service);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).recordLectureEvent = async (a: string, b: string, c: unknown) => {
        await origRecord(a, b, c);
        cache.clear();
      };

      await service.closeBySlug('s', 'u-1');

      expect(prisma.lectureRecording.create).not.toHaveBeenCalled();
      expect(prisma.lecture.update).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        data: expect.objectContaining({ status: 'cancelled' }),
      });
    });

    it('truncated=true при суммарном размере >50 MB (синтетический лимит через CONST = маленький не делаем)', async () => {
      // Чтобы не аллоцировать 50 MB в тесте, имитируем размер через
      // монки-патч константы LECTURE_RECORDING_MAX_BYTES на сервисе.
      const original = LiveAnalysisService.LECTURE_RECORDING_MAX_BYTES;
      Object.defineProperty(LiveAnalysisService, 'LECTURE_RECORDING_MAX_BYTES', {
        value: 100, // 100 байт — чтобы триггерить отсечение на нескольких маленьких событиях
        writable: true,
      });
      try {
        seedStateHash('la-1', 'fen', 'white');
        seedEvents('la-1', [
          { t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } }, // ~50 байт
          { t: 100, type: 'move', payload: { uci: 'e7e5', ply: 2 } }, // ~50 байт — суммарно >100
          { t: 200, type: 'move', payload: { uci: 'g1f3', ply: 3 } }, // отброшен
        ]);
        await service.closeBySlug('s', 'u-1');
        expect(prisma.lectureRecording.create).toHaveBeenCalled();
        const args = prisma.lectureRecording.create.mock.calls[0][0].data;
        expect(args.truncated).toBe(true);
        // в записи событий <3.
        expect(args.eventCount).toBeLessThan(3);
      } finally {
        Object.defineProperty(LiveAnalysisService, 'LECTURE_RECORDING_MAX_BYTES', {
          value: original,
          writable: true,
        });
      }
    });

    it('ошибка lectureRecording.create логируется и не валит закрытие', async () => {
      seedStateHash('la-1', 'fen', 'white');
      seedEvents('la-1', [{ t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } }]);
      prisma.lectureRecording.create.mockRejectedValueOnce(new Error('boom'));
      const res = await service.closeBySlug('s', 'u-1');
      expect(res.alreadyClosed).toBe(false);
      // LiveAnalysis всё равно ушёл в closed (UPDATE сделан).
      expect(prisma.liveAnalysis.update).toHaveBeenCalledWith({
        where: { id: 'la-1' },
        data: expect.objectContaining({ status: 'closed' }),
      });
      // Lecture осталась live → markLiveLectureEnded поставит endedAt.
      expect(prisma.lecture.updateMany).toHaveBeenCalled();
    });

    it('runCleanupTick тоже вызывает finalizer', async () => {
      seedStateHash('la-zombie', 'fen', 'white');
      seedEvents('la-zombie', [
        { t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } },
      ]);
      prisma.liveAnalysis.findMany.mockResolvedValueOnce([
        { id: 'la-zombie', slug: 'ZSLUG00000' },
      ]);
      prisma.lecture.findFirst.mockResolvedValue({
        id: 'l-zombie',
        startedAt: new Date(Date.now() - 60_000),
      });
      const result = await service.runCleanupTick();
      expect(result.locked).toBe(true);
      expect(result.closed).toBe(1);
      expect(prisma.lectureRecording.create).toHaveBeenCalled();
      const args = prisma.lectureRecording.create.mock.calls[0][0].data;
      expect(args.lectureId).toBe('l-zombie');
    });
  });
});
