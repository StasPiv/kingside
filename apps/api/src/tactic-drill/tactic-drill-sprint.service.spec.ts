/**
 * KS-2240. Юнит-тесты `TacticDrillSprintService`.
 *
 * Покрытие:
 *  - start: создаёт сессию, выбирает первую задачу, проверяет 409 на
 *    активную, force=true перезапускает.
 *  - submit: правильный/неправильный ответ → solved/score; mismatch
 *    drillId → 400; expired session → 404.
 *  - submit с истёкшим временем → final + persist в БД.
 *  - finishManual: persist + cleanup.
 *  - leaderboard: top-N + sort score desc.
 */

import { TacticDrillSprintService } from './tactic-drill-sprint.service';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

interface FakeRedis {
  store: Map<string, string>;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  keys: jest.Mock;
}

function makeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      const had = store.has(k);
      store.delete(k);
      return had ? 1 : 0;
    }),
    keys: jest.fn(async (pattern: string) => {
      // Минимальная имитация Redis-glob: только префикс "*" в конце.
      if (!pattern.endsWith('*')) {
        return Array.from(store.keys()).filter((k) => k === pattern);
      }
      const prefix = pattern.slice(0, -1);
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    }),
  };
}

function makePrisma() {
  return {
    tacticDrill: {
      // KS-2370/2371/2378: pickRandomByKeyset / pickRandomDrill используют
      // $queryRawUnsafe; tacticDrill.count/findFirst остаются для
      // pickRandomFromPool (lesson-flow) и других мест.
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    tacticDrillSprintScore: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // KS-2378: sprint pickRandomDrill переведён на keyset через raw SQL.
    $queryRawUnsafe: jest.fn(),
  } as unknown as PrismaService & Record<string, never>;
}

const DRILL_ROW_FORK = {
  id: 'drill-fork-1',
  type: 'find-fork',
  fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1',
  difficulty: 2,
  answer: { shape: 'square', square: 'c7' },
};

const DRILL_ROW_PIN = {
  id: 'drill-pin-1',
  type: 'find-pin',
  fen: '2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1',
  difficulty: 1,
  answer: { shape: 'square', square: 'c7' },
};

describe('TacticDrillSprintService — KS-2240', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let redis: FakeRedis;
  let drillService: TacticDrillService;
  let svc: TacticDrillSprintService;

  beforeEach(() => {
    prisma = makePrisma();
    redis = makeRedis();
    drillService = new TacticDrillService(
      prisma as unknown as PrismaService,
      new TacticDrillValidatorService(),
    );
    svc = new TacticDrillSprintService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      drillService,
      new TacticDrillValidatorService(),
    );
  });

  describe('start', () => {
    it('создаёт сессию и выдаёт первый drill', async () => {
      // KS-2378: pickRandomDrill через $queryRawUnsafe (keyset).
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([
        DRILL_ROW_FORK,
      ]);

      const r = await svc.start('user-1', {
        durationMs: 180000,
        types: ['find-fork'],
      });
      expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.drill.drillType).toBe('find-fork');
      expect(r.drill).not.toHaveProperty('answer');
      expect(r.durationMs).toBe(180000);

      // Состояние в Redis есть.
      const key = `drill-sprint:session:${r.sessionId}`;
      expect(redis.store.has(key)).toBe(true);
      const state = JSON.parse(redis.store.get(key)!);
      expect(state.userId).toBe('user-1');
      expect(state.modeLabel).toBe('3min-pattern');
    });

    it('активная сессия → 409', async () => {
      // Активная маркер уже есть.
      redis.store.set('drill-sprint:active:user-1', 'old-session');
      redis.store.set(
        'drill-sprint:session:old-session',
        JSON.stringify({
          sessionId: 'old-session',
          userId: 'user-1',
          startedAt: Date.now() - 1000,
          durationMs: 180000,
          types: ['find-fork'],
          modeLabel: '3min-pattern',
          currentDrillId: null,
          drillsServed: [],
          attempts: [],
        }),
      );

      await expect(
        svc.start('user-1', { durationMs: 180000, types: ['find-fork'] }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('force=true перезапускает существующую сессию', async () => {
      redis.store.set('drill-sprint:active:user-1', 'old-session');
      redis.store.set(
        'drill-sprint:session:old-session',
        JSON.stringify({
          sessionId: 'old-session',
          userId: 'user-1',
          startedAt: Date.now() - 1000,
          durationMs: 180000,
          types: ['find-fork'],
          modeLabel: '3min-pattern',
          currentDrillId: null,
          drillsServed: [],
          attempts: [],
        }),
      );
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([
        DRILL_ROW_FORK,
      ]);

      const r = await svc.start('user-1', {
        durationMs: 180000,
        types: ['find-fork'],
        force: true,
      });
      expect(r.sessionId).not.toBe('old-session');
      // Старая сессия удалена.
      expect(redis.store.has('drill-sprint:session:old-session')).toBe(false);
    });

    it('пул пуст → 404', async () => {
      // KS-2378: keyset возвращает [] для forward и [] для backward → null.
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.start('user-1', { durationMs: 180000, types: [] }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('некорректный durationMs → 400', async () => {
      await expect(
        svc.start('user-1', {
          durationMs: 60000 as 180000,
          types: ['find-fork'],
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('submit', () => {
    async function startSession(): Promise<string> {
      // KS-2378: pickRandomDrill вызывается дважды — на /start (первая
      // задача) и в /submit (next drill). Forward-keyset hit'ы.
      (prisma.$queryRawUnsafe as jest.Mock)
        .mockResolvedValueOnce([DRILL_ROW_FORK]) // первая задача
        .mockResolvedValueOnce([DRILL_ROW_PIN]); // следующая после submit
      const r = await svc.start('user-1', {
        durationMs: 180000,
        types: ['find-fork', 'find-pin'],
      });
      return r.sessionId;
    }

    it('правильный ответ → solved + next drill', async () => {
      const sessionId = await startSession();
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue({
        id: DRILL_ROW_FORK.id,
        answer: DRILL_ROW_FORK.answer,
      });
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-1',
      });

      const r = await svc.submit('user-1', {
        sessionId,
        drillId: DRILL_ROW_FORK.id,
        userAnswer: { shape: 'square', square: 'c7' },
        timeMs: 1500,
      });

      expect(r.attempt.solved).toBe(true);
      expect(r.next).not.toBeNull();
      expect(r.next?.drillType).toBe('find-pin');
      expect(r.final).toBeUndefined();

      // attemptId в формате sprint-...
      expect(r.attempt.attemptId).toMatch(/^sprint-/);
    });

    it('drillId mismatch → 400', async () => {
      const sessionId = await startSession();
      await expect(
        svc.submit('user-1', {
          sessionId,
          drillId: 'wrong-drill-id',
          userAnswer: { shape: 'square', square: 'c7' },
          timeMs: 100,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('сессия истекла (нет в Redis) → 404', async () => {
      await expect(
        svc.submit('user-1', {
          sessionId: 'no-such-session',
          drillId: 'd',
          userAnswer: { shape: 'square', square: 'c7' },
          timeMs: 0,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('таймаут после ответа → final + БД-запись + Redis-cleanup', async () => {
      const sessionId = await startSession();
      // Подкрутить state так, чтобы при следующем submit elapsed > duration.
      const key = `drill-sprint:session:${sessionId}`;
      const state = JSON.parse(redis.store.get(key)!);
      state.startedAt = Date.now() - 200000; // 200s > 180s duration
      redis.store.set(key, JSON.stringify(state));

      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue({
        id: DRILL_ROW_FORK.id,
        answer: DRILL_ROW_FORK.answer,
      });
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-final',
      });

      const r = await svc.submit('user-1', {
        sessionId,
        drillId: DRILL_ROW_FORK.id,
        userAnswer: { shape: 'square', square: 'a1' }, // wrong
        timeMs: 5000,
      });

      expect(r.next).toBeNull();
      expect(r.final).toBeDefined();
      expect(r.final?.scoreId).toBe('score-final');
      expect(r.final?.score).toBe(0); // 1 attempt, 0 solved
      expect(r.final?.accuracy).toBe(0);
      // Persist вызван с правильными полями.
      expect(prisma.tacticDrillSprintScore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            score: 0,
            drillsCount: 1,
            accuracy: 0,
            // KS-2334: оба типа (find-fork, find-pin) ∈ pattern-слой
            // → mode нормализуется в `${min}min-${layer}`.
            mode: '3min-pattern',
          }),
        }),
      );
      // Redis-сессия удалена.
      expect(redis.store.has(key)).toBe(false);
    });
  });

  describe('finishManual', () => {
    it('сохраняет score и чистит Redis', async () => {
      // Подсадим session с двумя attempts (1 solved).
      const sessionId = 'manual-finish-1';
      const state = {
        sessionId,
        userId: 'user-1',
        startedAt: Date.now(),
        durationMs: 180000,
        types: ['find-fork'],
        modeLabel: '3min-pattern',
        currentDrillId: null,
        drillsServed: ['d1', 'd2'],
        attempts: [
          { drillId: 'd1', solved: true, timeMs: 1000, iou: null },
          { drillId: 'd2', solved: false, timeMs: 2000, iou: null },
        ],
      };
      redis.store.set(`drill-sprint:session:${sessionId}`, JSON.stringify(state));
      redis.store.set('drill-sprint:active:user-1', sessionId);
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-manual',
      });

      const r = await svc.finishManual('user-1', sessionId);
      expect(r.score).toBe(1);
      expect(r.accuracy).toBe(0.5);
      expect(redis.store.has(`drill-sprint:session:${sessionId}`)).toBe(false);
      expect(redis.store.has('drill-sprint:active:user-1')).toBe(false);
    });
  });

  describe('getActiveSession — KS-2352', () => {
    it('нет активной сессии → null', async () => {
      const r = await svc.getActiveSession('user-1');
      expect(r).toBeNull();
    });

    it('active-маркер есть, но session-state истёк → null + cleanup', async () => {
      redis.store.set('drill-sprint:active:user-1', 'orphan-id');
      // session-key отсутствует.
      const r = await svc.getActiveSession('user-1');
      expect(r).toBeNull();
      expect(redis.store.has('drill-sprint:active:user-1')).toBe(false);
    });

    it('активная сессия → возвращает sessionId/drill/durationMs/remainingMs/modeLabel', async () => {
      const sessionId = 'sess-1';
      const startedAt = Date.now() - 30_000; // 30s назад
      const state = {
        sessionId,
        userId: 'user-1',
        startedAt,
        durationMs: 180_000,
        types: ['find-fork'],
        modeLabel: '3min-pattern',
        currentDrillId: DRILL_ROW_FORK.id,
        drillsServed: [DRILL_ROW_FORK.id],
        attempts: [
          { drillId: DRILL_ROW_FORK.id, solved: true, timeMs: 1000, iou: null },
        ],
      };
      redis.store.set('drill-sprint:active:user-1', sessionId);
      redis.store.set(
        `drill-sprint:session:${sessionId}`,
        JSON.stringify(state),
      );
      (prisma.tacticDrill.findUnique as jest.Mock).mockResolvedValue(
        DRILL_ROW_FORK,
      );

      const r = await svc.getActiveSession('user-1');
      expect(r).not.toBeNull();
      expect(r!.sessionId).toBe(sessionId);
      expect(r!.drill.id).toBe(DRILL_ROW_FORK.id);
      expect(r!.durationMs).toBe(180_000);
      expect(r!.modeLabel).toBe('3min-pattern');
      expect(r!.attemptsCount).toBe(1);
      // remainingMs = duration - elapsed; elapsed≈30s → remaining≈150s
      expect(r!.remainingMs).toBeGreaterThan(140_000);
      expect(r!.remainingMs).toBeLessThanOrEqual(180_000);
      // drill эталон НЕ возвращается (api-contract §7).
      expect((r!.drill as unknown as Record<string, unknown>)).not.toHaveProperty(
        'answer',
      );
    });

    it('userId mismatch (чужая сессия) → null', async () => {
      const sessionId = 'sess-other';
      redis.store.set('drill-sprint:active:user-1', sessionId);
      redis.store.set(
        `drill-sprint:session:${sessionId}`,
        JSON.stringify({
          sessionId,
          userId: 'different-user',
          startedAt: Date.now(),
          durationMs: 180_000,
          types: ['find-fork'],
          modeLabel: '3min-pattern',
          currentDrillId: 'd',
          drillsServed: ['d'],
          attempts: [],
        }),
      );
      const r = await svc.getActiveSession('user-1');
      expect(r).toBeNull();
    });
  });

  describe('leaderboard', () => {
    it('возвращает top-N с username и score desc', async () => {
      (prisma.tacticDrillSprintScore.findMany as jest.Mock).mockResolvedValue([
        {
          userId: 'u1',
          score: 30,
          accuracy: 0.9,
          mode: '3min-mixed',
          createdAt: new Date('2026-05-01'),
          user: { username: 'alice' },
        },
        {
          userId: 'u2',
          score: 25,
          accuracy: 0.8,
          mode: '3min-mixed',
          createdAt: new Date('2026-05-02'),
          user: { username: 'bob' },
        },
      ]);

      const r = await svc.leaderboard('3min-mixed', 10);
      expect(r.entries).toHaveLength(2);
      expect(r.entries[0].username).toBe('alice');
      expect(r.entries[0].score).toBe(30);
      expect(prisma.tacticDrillSprintScore.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mode: '3min-mixed' },
          take: 10,
          orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
        }),
      );
    });

    it('limit clamped до 500', async () => {
      (prisma.tacticDrillSprintScore.findMany as jest.Mock).mockResolvedValue([]);
      await svc.leaderboard('3min-mixed', 9999);
      expect(prisma.tacticDrillSprintScore.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 }),
      );
    });
  });

  describe('autoFinalizeExpiredSessions — KS-2380', () => {
    function putSession(
      sessionId: string,
      userId: string,
      overrides: Partial<{
        startedAt: number;
        durationMs: number;
        attempts: { drillId: string; solved: boolean; timeMs: number; iou: number | null }[];
        modeLabel: string;
        types: string[];
      }>,
    ): void {
      const state = {
        sessionId,
        userId,
        startedAt: overrides.startedAt ?? Date.now(),
        durationMs: overrides.durationMs ?? 180000,
        types: overrides.types ?? ['find-fork'],
        modeLabel: overrides.modeLabel ?? '3min-pattern',
        currentDrillId: null,
        drillsServed: ['d1'],
        attempts:
          overrides.attempts ?? [
            { drillId: 'd1', solved: true, timeMs: 1000, iou: null },
          ],
      };
      redis.store.set(`drill-sprint:session:${sessionId}`, JSON.stringify(state));
      redis.store.set(`drill-sprint:active:${userId}`, sessionId);
    }

    it('пустой Redis → no-op', async () => {
      const r = await svc.autoFinalizeExpiredSessions();
      expect(r).toEqual({ scanned: 0, finalized: 0, skipped: 0 });
    });

    it('активная (не timedOut) сессия → пропуск', async () => {
      putSession('s-running', 'u-1', { startedAt: Date.now() - 30_000 });
      const r = await svc.autoFinalizeExpiredSessions();
      expect(r.scanned).toBe(1);
      expect(r.finalized).toBe(0);
      expect(r.skipped).toBe(1);
      // Сессия не тронута.
      expect(redis.store.has('drill-sprint:session:s-running')).toBe(true);
      expect(redis.store.has('drill-sprint:active:u-1')).toBe(true);
      expect(prisma.tacticDrillSprintScore.create).not.toHaveBeenCalled();
    });

    it('timedOut + есть attempts → finalize + cleanup БД и Redis', async () => {
      putSession('s-expired', 'u-2', {
        startedAt: Date.now() - 200_000, // 200с > 180с + grace 5с
        modeLabel: '3min-mixed',
        types: [
          'find-hanging-piece',
          'find-loose-piece',
          'find-pin',
          'find-fork',
          'count-attackers',
          'find-all-checks',
          'find-undefended-attack',
        ],
        attempts: [
          { drillId: 'd1', solved: true, timeMs: 1000, iou: null },
          { drillId: 'd2', solved: false, timeMs: 2000, iou: null },
          { drillId: 'd3', solved: true, timeMs: 1500, iou: null },
        ],
      });
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-auto-1',
      });

      const r = await svc.autoFinalizeExpiredSessions();
      expect(r).toEqual({ scanned: 1, finalized: 1, skipped: 0 });

      expect(prisma.tacticDrillSprintScore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u-2',
            score: 2,
            drillsCount: 3,
            mode: '3min-mixed',
          }),
        }),
      );
      // Redis-сессия и active-маркер удалены.
      expect(redis.store.has('drill-sprint:session:s-expired')).toBe(false);
      expect(redis.store.has('drill-sprint:active:u-2')).toBe(false);
    });

    it('timedOut, но 0 attempts → пустую запись не пишем; Redis cleanup', async () => {
      putSession('s-empty', 'u-3', {
        startedAt: Date.now() - 200_000,
        attempts: [],
      });
      const r = await svc.autoFinalizeExpiredSessions();
      expect(r).toEqual({ scanned: 1, finalized: 0, skipped: 0 });
      expect(prisma.tacticDrillSprintScore.create).not.toHaveBeenCalled();
      expect(redis.store.has('drill-sprint:session:s-empty')).toBe(false);
      expect(redis.store.has('drill-sprint:active:u-3')).toBe(false);
    });

    it('сломанный JSON → удаляется, не валит scan', async () => {
      redis.store.set('drill-sprint:session:s-broken', '{not-json');
      const r = await svc.autoFinalizeExpiredSessions();
      expect(r.scanned).toBe(1);
      expect(r.finalized).toBe(0);
      expect(redis.store.has('drill-sprint:session:s-broken')).toBe(false);
    });

    it('повторный вызов не финализирует ту же сессию дважды', async () => {
      putSession('s-once', 'u-4', {
        startedAt: Date.now() - 200_000,
        attempts: [{ drillId: 'd1', solved: true, timeMs: 1000, iou: null }],
      });
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-once',
      });
      const r1 = await svc.autoFinalizeExpiredSessions();
      const r2 = await svc.autoFinalizeExpiredSessions();
      expect(r1.finalized).toBe(1);
      expect(r2.finalized).toBe(0);
      expect(prisma.tacticDrillSprintScore.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildModeLabel — KS-2334', () => {
    /**
     * Косвенная проверка через `start`: сессия в Redis содержит modeLabel.
     * Формат должен совпадать с фронтовым фильтром
     * `${min}min-${set}`, set ∈ mixed/overview/pattern/calculation/custom.
     */
    async function modeLabelOfStart(
      durationMs: 180000 | 300000,
      types: string[],
    ): Promise<string> {
      // KS-2378: keyset вместо count + findFirst.
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([
        DRILL_ROW_FORK,
      ]);
      const r = await svc.start(`u-${Math.random()}`, {
        durationMs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        types: types as any,
      });
      const key = `drill-sprint:session:${r.sessionId}`;
      const state = JSON.parse(redis.store.get(key)!);
      return state.modeLabel;
    }

    // KS-2393: после удаления mate-in-1 (deprecated) типов теперь 7.
    it('все 7 типов → Nmin-mixed', async () => {
      const all = [
        'find-hanging-piece',
        'find-loose-piece',
        'find-pin',
        'find-fork',
        'count-attackers',
        'find-all-checks',
        'find-undefended-attack',
      ];
      expect(await modeLabelOfStart(180000, all)).toBe('3min-mixed');
      expect(await modeLabelOfStart(300000, all)).toBe('5min-mixed');
    });

    it('один тип → слой этого типа', async () => {
      // find-loose-piece ∈ overview
      expect(await modeLabelOfStart(180000, ['find-loose-piece'])).toBe(
        '3min-overview',
      );
      // find-fork ∈ pattern
      expect(await modeLabelOfStart(180000, ['find-fork'])).toBe(
        '3min-pattern',
      );
      // find-undefended-attack ∈ calculation
      expect(await modeLabelOfStart(300000, ['find-undefended-attack'])).toBe(
        '5min-calculation',
      );
    });

    it('подмножество одного слоя → слой', async () => {
      // pattern-слой = {find-all-checks, find-pin, find-fork}; берём 2 из 3
      expect(
        await modeLabelOfStart(180000, ['find-pin', 'find-fork']),
      ).toBe('3min-pattern');
    });

    it('микс из разных слоёв (но не все 8) → custom', async () => {
      // overview + pattern
      expect(
        await modeLabelOfStart(180000, ['find-loose-piece', 'find-fork']),
      ).toBe('3min-custom');
    });
  });

  describe('round-robin по типам — KS-2424', () => {
    /**
     * KS-2424: при выборе всех типов sprint выдавал drill'ы блоками
     * по типам (find-loose-piece часто, find-fork редко) — из-за
     * неравномерности пула в БД. Теперь — round-robin по shuffled-
     * порядку: на pick #k берётся `state.types[k % len]`. Тест
     * проверяет, что в первых 10 drill'ах присутствуют все 7 типов.
     */
    function setupRoundRobinMock(): void {
      // Мок $queryRawUnsafe: возвращает drill соответствующего
      // запрошенного типа. params[0] — массив типов, обычно из 1
      // элемента (primary-pick); fallback может быть длиннее.
      let counter = 0;
      (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(
        async (_sql: string, ...params: unknown[]) => {
          const types = params[0] as string[];
          const type = types[0];
          counter += 1;
          return [
            {
              id: `drill-${type}-${counter}`,
              type,
              fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
              difficulty: 1,
              meta: null,
              answer: { shape: 'square', square: 'a1' },
            },
          ];
        },
      );
    }

    it('mixed sprint всех 7 типов → в первых 10 drill\'ах присутствуют все 7 типов', async () => {
      setupRoundRobinMock();
      const allTypes = [
        'find-hanging-piece',
        'find-loose-piece',
        'find-pin',
        'find-fork',
        'count-attackers',
        'find-all-checks',
        'find-undefended-attack',
      ] as const;

      const r = await svc.start('user-rr', {
        durationMs: 300000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        types: allTypes as any,
      });
      // findUnique для submit — отдаём drill по id (мок).
      (prisma.tacticDrill.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          answer: { shape: 'square', square: 'a1' },
        }),
      );
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-1',
      });

      const seenTypes = new Set<string>();
      seenTypes.add(r.drill.drillType);

      let currentDrillId = r.drill.id;
      for (let i = 0; i < 9; i++) {
        const submit = await svc.submit('user-rr', {
          sessionId: r.sessionId,
          drillId: currentDrillId,
          userAnswer: { shape: 'square', square: 'a1' },
          timeMs: 1000,
        });
        expect(submit.next).not.toBeNull();
        if (!submit.next) break;
        seenTypes.add(submit.next.drillType);
        currentDrillId = submit.next.id;
      }

      // В первых 10 drill'ах (1 из start + 9 из submit) должны быть
      // все 7 типов — round-robin гарантирует это в первом цикле.
      expect(seenTypes.size).toBe(allTypes.length);
      for (const t of allTypes) {
        expect(seenTypes.has(t)).toBe(true);
      }
    });

    it('mixed sprint: 30 picks → одинаковая частота каждого типа (~30/7≈4.3)', async () => {
      setupRoundRobinMock();
      const allTypes = [
        'find-hanging-piece',
        'find-loose-piece',
        'find-pin',
        'find-fork',
        'count-attackers',
        'find-all-checks',
        'find-undefended-attack',
      ] as const;

      const r = await svc.start('user-strat', {
        durationMs: 300000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        types: allTypes as any,
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          answer: { shape: 'square', square: 'a1' },
        }),
      );
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-1',
      });

      const counts = new Map<string, number>();
      const bump = (t: string): void => {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      };
      bump(r.drill.drillType);

      let currentDrillId = r.drill.id;
      for (let i = 0; i < 29; i++) {
        const submit = await svc.submit('user-strat', {
          sessionId: r.sessionId,
          drillId: currentDrillId,
          userAnswer: { shape: 'square', square: 'a1' },
          timeMs: 1000,
        });
        expect(submit.next).not.toBeNull();
        if (!submit.next) break;
        bump(submit.next.drillType);
        currentDrillId = submit.next.id;
      }

      // 30 picks / 7 типов = round-robin даёт 4 или 5 каждого типа
      // (4*7=28, остаток 2 → 2 типа получат +1).
      for (const t of allTypes) {
        const c = counts.get(t) ?? 0;
        expect(c).toBeGreaterThanOrEqual(4);
        expect(c).toBeLessThanOrEqual(5);
      }
    });

    it('один тип → round-robin тривиален, все picks из этого типа', async () => {
      setupRoundRobinMock();
      const r = await svc.start('user-single', {
        durationMs: 180000,
        types: ['find-fork'],
      });
      (prisma.tacticDrill.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          answer: { shape: 'square', square: 'a1' },
        }),
      );
      expect(r.drill.drillType).toBe('find-fork');

      const submit = await svc.submit('user-single', {
        sessionId: r.sessionId,
        drillId: r.drill.id,
        userAnswer: { shape: 'square', square: 'a1' },
        timeMs: 1000,
      });
      expect(submit.next?.drillType).toBe('find-fork');
    });

    it('KS-2429: count-attackers → распределение value по {1,2,3,4} близко к равномерному', async () => {
      // Симулируем БД с равным количеством drill'ов каждого value.
      // Мок $queryRawUnsafe смотрит на SQL: если есть фильтр
      // `(answer->>'value')::int = $N` — извлекаем $N из params и
      // возвращаем drill с этим value. Иначе (без value-фильтра) —
      // возвращаем drill с value=1 (имитируя перекошенный банк, где
      // value=1 сильно доминирует).
      (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(
        async (sql: string, ...params: unknown[]) => {
          const types = params[0] as string[];
          const type = types[0];
          // SQL содержит value-filter если в параметрах есть число
          // после массива типов. params = [types, value?, excludeIds?].
          const hasValueFilter = sql.includes("(answer->>'value')::int");
          let value: number;
          if (hasValueFilter) {
            value = params[1] as number;
          } else {
            value = 1; // bare bank — почти всё value=1
          }
          return [
            {
              id: `drill-${type}-${value}-${Math.random()}`,
              type,
              fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
              difficulty: 1,
              meta: { highlightedSquare: 'a1', attackerColor: 'b' },
              answer: { shape: 'number', value },
            },
          ];
        },
      );
      (prisma.tacticDrill.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          // value прокидываем через id (parsed выше): берём 3-й сегмент.
          answer: {
            shape: 'number',
            value: parseInt(where.id.split('-')[3] ?? '1', 10),
          },
        }),
      );
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-1',
      });

      const r = await svc.start('user-ca', {
        durationMs: 300000,
        types: ['count-attackers'],
      });
      // Парсим value из drill.id (хак для теста, в проде value придёт
      // от prisma findUnique через answer.value).
      const observedValues: number[] = [];
      const parseV = (id: string): number =>
        parseInt(id.split('-')[3] ?? '1', 10);
      observedValues.push(parseV(r.drill.id));

      let currentDrillId = r.drill.id;
      for (let i = 0; i < 99; i++) {
        const submit = await svc.submit('user-ca', {
          sessionId: r.sessionId,
          drillId: currentDrillId,
          // userAnswer должен пройти validator — neutral
          userAnswer: { shape: 'number', value: 1 },
          timeMs: 1000,
        });
        if (!submit.next) break;
        observedValues.push(parseV(submit.next.id));
        currentDrillId = submit.next.id;
      }

      expect(observedValues.length).toBe(100);
      const counts = new Map<number, number>();
      for (const v of observedValues) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      // Все 4 value должны присутствовать.
      for (const v of [1, 2, 3, 4]) {
        expect(counts.get(v) ?? 0).toBeGreaterThan(0);
      }
      // Распределение близко к равномерному: max/min < 3 (ожидаем
      // 25/25/25/25 ± шум). Без балансировки было бы ~95/2/2/1.
      const cs = [1, 2, 3, 4].map((v) => counts.get(v) ?? 0);
      const minCount = Math.min(...cs);
      const maxCount = Math.max(...cs);
      expect(maxCount / Math.max(minCount, 1)).toBeLessThan(3);
    });

    it('KS-2429: count-attackers → в первых 10 drill\'ах ≥3 разных value', async () => {
      // Acceptance из тикета: «первые 10 drill'ов содержат разные
      // value (хотя бы 3 разных из {1,2,3,4})».
      (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(
        async (sql: string, ...params: unknown[]) => {
          const types = params[0] as string[];
          const type = types[0];
          const hasValueFilter = sql.includes("(answer->>'value')::int");
          const value = hasValueFilter ? (params[1] as number) : 1;
          return [
            {
              id: `drill-${type}-${value}-${Math.random()}`,
              type,
              fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
              difficulty: 1,
              meta: { highlightedSquare: 'a1', attackerColor: 'b' },
              answer: { shape: 'number', value },
            },
          ];
        },
      );
      (prisma.tacticDrill.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          answer: {
            shape: 'number',
            value: parseInt(where.id.split('-')[3] ?? '1', 10),
          },
        }),
      );
      (prisma.tacticDrillSprintScore.create as jest.Mock).mockResolvedValue({
        id: 'score-1',
      });

      const r = await svc.start('user-ca-10', {
        durationMs: 300000,
        types: ['count-attackers'],
      });
      const seen = new Set<number>();
      seen.add(parseInt(r.drill.id.split('-')[3] ?? '1', 10));

      let currentDrillId = r.drill.id;
      for (let i = 0; i < 9; i++) {
        const submit = await svc.submit('user-ca-10', {
          sessionId: r.sessionId,
          drillId: currentDrillId,
          userAnswer: { shape: 'number', value: 1 },
          timeMs: 1000,
        });
        if (!submit.next) break;
        seen.add(parseInt(submit.next.id.split('-')[3] ?? '1', 10));
        currentDrillId = submit.next.id;
      }
      // ≥3 разных value в первых 10 drill'ах. С Math.random() шанс что
      // 10 random'ов из {1,2,3,4} дадут <3 разных value пренебрежимо
      // мал (~0.1%): P(seen<3) = 4*(3/4)^10 + 4*3*(1/2)^10 ≈ 0.24%.
      expect(seen.size).toBeGreaterThanOrEqual(3);
    });

    it('fallback: primary-тип исчерпан → берём из остальных типов rotation', async () => {
      // На первый pick (primary single-type) возвращаем []; далее
      // мок отдаёт drill из «оставшихся».
      let primaryCalls = 0;
      (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(
        async (_sql: string, ...params: unknown[]) => {
          const types = params[0] as string[];
          const type = types[0];
          if (types.length === 1 && primaryCalls === 0) {
            // Первый primary-вызов — пусто, симулируем исчерпанный пул.
            primaryCalls++;
            return [];
          }
          // Дальше — нормально (fwd может вернуть пусто, тогда вызов
          // bwd; для простоты возвращаем drill всегда, кроме первого).
          return [
            {
              id: `drill-${type}-${primaryCalls++}`,
              type,
              fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
              difficulty: 1,
              meta: null,
              answer: { shape: 'square', square: 'a1' },
            },
          ];
        },
      );
      const r = await svc.start('user-fb', {
        durationMs: 180000,
        types: ['find-fork', 'find-pin'],
      });
      // Первый pick: primary=один из двух → пусто (fwd+bwd); fallback на
      // другой тип → есть.
      expect(r.drill).toBeDefined();
      expect(['find-fork', 'find-pin']).toContain(r.drill.drillType);
    });
  });
});
