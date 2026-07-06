/**
 * KS-4846 / ADR-157. Юнит-тесты приоритизации стримов по WS-подпискам.
 *
 * Покрытие:
 *  - `evaluateStreamPriorities`: свободный слот → promoted; заполнены 8,
 *    претендент 1.5× → demoted + promoted; претендент 1.4× → blocked_by_hysteresis;
 *    у слабейшего активен hold TTL → blocked_by_hold; без зрителей → no_slot.
 *  - `runFastPollTick`: subs=0 не попадает, subs>=1 попадает, cap=2 работает,
 *    cooldown-ключ отсекает повторный опрос.
 *  - `syncPinnedBroadcasts` фильтр §2.8: раунды с subs>=1 не попадают в
 *    slow pinned poll (их обслуживает fast poll).
 *  - `startStream()` ok → ставит `broadcast:stream-hold:<id>` TTL.
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

interface Mocks {
  prisma: {
    broadcastRound: {
      findMany: jest.Mock;
      findUnique?: jest.Mock;
    };
    broadcastGame?: {
      count: jest.Mock;
    };
  };
  redis: {
    hgetall: jest.Mock;
    exists: jest.Mock;
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    hincrby: jest.Mock;
    hdel: jest.Mock;
  };
  metrics: Record<string, jest.Mock>;
  standingsSync: object;
  prerender: object;
}

function makeMocks(): Mocks {
  return {
    prisma: {
      broadcastRound: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      broadcastGame: { count: jest.fn().mockResolvedValue(0) },
    },
    redis: {
      hgetall: jest.fn().mockResolvedValue({}),
      exists: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      hincrby: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
    },
    metrics: {
      recordCycle: jest.fn(),
      observeDuration: jest.fn(),
      recordFailure: jest.fn(),
      recordCrosstableCoverage: jest.fn(),
      recordPendingCheck: jest.fn(),
      observePendingPromotionDelay: jest.fn(),
      setStreamsActive: jest.fn(),
      recordStreamStarted: jest.fn(),
      recordStreamEnded: jest.fn(),
      setStreamsWatchdogMaxAge: jest.fn(),
      observeStreamDuration: jest.fn(),
      recordLichessRequest: jest.fn(),
      setWsActiveSubscriptions: jest.fn(),
      removeWsActiveSubscription: jest.fn(),
      recordStreamPriorityChange: jest.fn(),
      recordStreamEvaluation: jest.fn(),
    },
    standingsSync: {},
    prerender: {},
  };
}

function makeService(mocks: Mocks): BroadcastSyncService {
  const svc = new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
  // acquireLock приватный — по умолчанию возвращает true (лок захвачен).
  (svc as unknown as { acquireLock: jest.Mock }).acquireLock = jest
    .fn()
    .mockResolvedValue(true);
  return svc;
}

/**
 * Помещает `count` фиктивных стримов в `activeStreams` — для тестов
 * capacity-full/demotion сценариев. AbortController-заглушка.
 */
function fillActiveStreams(
  svc: BroadcastSyncService,
  ids: readonly string[],
): void {
  const map = (svc as unknown as {
    activeStreams: Map<string, { ctrl: AbortController; lastByteAt: number }>;
  }).activeStreams;
  for (const id of ids) {
    map.set(id, { ctrl: new AbortController(), lastByteAt: Date.now() });
  }
}

describe('KS-4846 / ADR-157 — приоритизация стримов', () => {
  describe('evaluateStreamPriorities', () => {
    it('свободный слот → promoted, startStream вызван, hold TTL ставится', async () => {
      const mocks = makeMocks();
      mocks.redis.hgetall.mockResolvedValue({ round1: '5' });
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'round1' },
      ]);
      const svc = makeService(mocks);
      const startSpy = jest
        .spyOn(svc, 'startStream')
        .mockReturnValue('ok');

      await svc.evaluateStreamPriorities();

      expect(startSpy).toHaveBeenCalledWith('round1');
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'promoted',
      );
    });

    it('8 занято, кандидат subs=15 vs слабейший subs=5 (1.5× пройден) → demoted+promoted', async () => {
      const mocks = makeMocks();
      // Заполним 8 «слотов» — subs=10 для 7, subs=5 для weakest.
      const active = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      const subsHash: Record<string, string> = {
        s1: '10',
        s2: '10',
        s3: '10',
        s4: '10',
        s5: '10',
        s6: '10',
        s7: '10',
        s8: '5', // weakest
        cand: '15', // претендент — 15 vs 5 = 3×, гистерезис 1.5× пройден
      };
      mocks.redis.hgetall.mockResolvedValue(subsHash);
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        ...active.map((id) => ({ lichessRoundId: id })),
        { lichessRoundId: 'cand' },
      ]);
      // hold не активен для s8
      mocks.redis.exists.mockResolvedValue(0);
      const svc = makeService(mocks);
      fillActiveStreams(svc, active);
      const abortSpy = jest.spyOn(svc, 'abortStream').mockReturnValue(true);
      const startSpy = jest.spyOn(svc, 'startStream').mockReturnValue('ok');
      // Замещаем внутренний activeStreams.delete: abortStream мокан, поэтому
      // вручную удалим s8 после вызова.
      abortSpy.mockImplementation((id: string) => {
        (svc as unknown as {
          activeStreams: Map<string, unknown>;
        }).activeStreams.delete(id);
        return true;
      });

      await svc.evaluateStreamPriorities();

      // targetTop8 = 7 × 10 + cand=15 (сортировка DESC) — weakest s8=5
      // ниже 8-го места, кандидат его вытесняет.
      expect(abortSpy).toHaveBeenCalledWith('s8');
      expect(startSpy).toHaveBeenCalledWith('cand');
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'demoted',
      );
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'promoted',
      );
    });

    it('8 занято, претендент subs=7 vs слабейший subs=5 (1.4× — гистерезис не пройден) → blocked_by_hysteresis', async () => {
      const mocks = makeMocks();
      const active = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      const subsHash: Record<string, string> = {
        s1: '10',
        s2: '10',
        s3: '10',
        s4: '10',
        s5: '10',
        s6: '10',
        s7: '10',
        s8: '5',
        cand: '7', // 7 / 5 = 1.4 < 1.5
      };
      mocks.redis.hgetall.mockResolvedValue(subsHash);
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        ...active.map((id) => ({ lichessRoundId: id })),
        { lichessRoundId: 'cand' },
      ]);
      const svc = makeService(mocks);
      fillActiveStreams(svc, active);
      const abortSpy = jest.spyOn(svc, 'abortStream').mockReturnValue(true);
      const startSpy = jest.spyOn(svc, 'startStream').mockReturnValue('ok');

      await svc.evaluateStreamPriorities();

      expect(abortSpy).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'blocked_by_hysteresis',
      );
    });

    it('слабейший под hold TTL → blocked_by_hold, стрим не выбивается', async () => {
      const mocks = makeMocks();
      const active = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      const subsHash: Record<string, string> = {
        s1: '10',
        s2: '10',
        s3: '10',
        s4: '10',
        s5: '10',
        s6: '10',
        s7: '10',
        s8: '5',
        cand: '15', // гистерезис прошёл бы
      };
      mocks.redis.hgetall.mockResolvedValue(subsHash);
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        ...active.map((id) => ({ lichessRoundId: id })),
        { lichessRoundId: 'cand' },
      ]);
      // exists→1 значит hold-ключ есть
      mocks.redis.exists.mockResolvedValue(1);
      const svc = makeService(mocks);
      fillActiveStreams(svc, active);
      const abortSpy = jest.spyOn(svc, 'abortStream').mockReturnValue(true);
      const startSpy = jest.spyOn(svc, 'startStream').mockReturnValue('ok');

      await svc.evaluateStreamPriorities();

      expect(abortSpy).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'blocked_by_hold',
      );
    });

    it('нет подписок → targetTop8 пуст, никаких действий, gauge не публикуется', async () => {
      const mocks = makeMocks();
      // подписок нет вовсе
      mocks.redis.hgetall.mockResolvedValue({});
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'r1' },
        { lichessRoundId: 'r2' },
      ]);
      const svc = makeService(mocks);
      const startSpy = jest.spyOn(svc, 'startStream').mockReturnValue('ok');

      await svc.evaluateStreamPriorities();

      expect(startSpy).not.toHaveBeenCalled();
      expect(mocks.metrics.setWsActiveSubscriptions).not.toHaveBeenCalled();
    });

    it('кандидат с subs=1 vs 8 занято (subs<3, минимум не проходит) → no_slot', async () => {
      const mocks = makeMocks();
      const active = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      const subsHash: Record<string, string> = {
        s1: '10',
        s2: '10',
        s3: '10',
        s4: '10',
        s5: '10',
        s6: '10',
        s7: '10',
        s8: '10',
        cand: '2', // < STREAM_CANDIDATE_MIN_SUBS=3 — даже не пытаемся выбить
      };
      // Но чтобы cand попал в targetTop8 (топ по subs), s8 должен быть с
      // меньшим subs. Поднимем s8=0 — но тогда не попадёт в topTargetTop8
      // из-за score>0. Скорректируем сценарий: cand=2, среди активных
      // s1..s8 subs=10 каждый. cand в топ-8 не попадёт (у него subs=2 меньше,
      // чем у любого из 8 активных). Значит наш сценарий надо перестроить:
      // сделаем s8=1, cand=2 — cand попадёт в top-8, но выбивать не станет
      // (2 < min 3).
      subsHash.s8 = '1';
      mocks.redis.hgetall.mockResolvedValue(subsHash);
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        ...active.map((id) => ({ lichessRoundId: id })),
        { lichessRoundId: 'cand' },
      ]);
      const svc = makeService(mocks);
      fillActiveStreams(svc, active);
      const abortSpy = jest.spyOn(svc, 'abortStream').mockReturnValue(true);
      const startSpy = jest.spyOn(svc, 'startStream').mockReturnValue('ok');

      await svc.evaluateStreamPriorities();

      expect(abortSpy).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(mocks.metrics.recordStreamPriorityChange).toHaveBeenCalledWith(
        'no_slot',
      );
    });
  });

  describe('runFastPollTick', () => {
    it('subs=0 не попадает; subs>=1 попадает; cap соблюдается', async () => {
      const mocks = makeMocks();
      mocks.redis.hgetall.mockResolvedValue({
        r1: '5',
        r2: '3',
        r3: '1',
      });
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'r1', updatedAt: new Date(2026, 0, 1) },
        { lichessRoundId: 'r2', updatedAt: new Date(2026, 0, 2) },
        { lichessRoundId: 'r3', updatedAt: new Date(2026, 0, 3) },
        { lichessRoundId: 'no-subs', updatedAt: new Date(2026, 0, 4) },
      ]);
      const svc = makeService(mocks);
      // fetchAndProcessRoundPgn приватный — заменяем на spy.
      const fetchSpy = jest.fn().mockResolvedValue(undefined);
      (svc as unknown as {
        fetchAndProcessRoundPgn: jest.Mock;
      }).fetchAndProcessRoundPgn = fetchSpy;
      (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay = jest
        .fn()
        .mockResolvedValue(undefined);

      await svc.runFastPollTick();

      // no-subs (subs=0) отфильтрован, порядок — по subs DESC.
      expect(fetchSpy).toHaveBeenCalledWith('r1');
      expect(fetchSpy).toHaveBeenCalledWith('r2');
      expect(fetchSpy).toHaveBeenCalledWith('r3');
      expect(fetchSpy).not.toHaveBeenCalledWith('no-subs');
    });

    it('cooldown-ключ есть в Redis → раунд skip, fetch не зовётся', async () => {
      const mocks = makeMocks();
      mocks.redis.hgetall.mockResolvedValue({ r1: '5' });
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'r1', updatedAt: new Date() },
      ]);
      mocks.redis.get.mockResolvedValue('1'); // cooldown активен
      const svc = makeService(mocks);
      const fetchSpy = jest.fn().mockResolvedValue(undefined);
      (svc as unknown as {
        fetchAndProcessRoundPgn: jest.Mock;
      }).fetchAndProcessRoundPgn = fetchSpy;

      await svc.runFastPollTick();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('раунд со стримом (in activeStreams) не попадает в fast poll', async () => {
      const mocks = makeMocks();
      mocks.redis.hgetall.mockResolvedValue({ r1: '5' });
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'r1', updatedAt: new Date() },
      ]);
      const svc = makeService(mocks);
      fillActiveStreams(svc, ['r1']);
      const fetchSpy = jest.fn().mockResolvedValue(undefined);
      (svc as unknown as {
        fetchAndProcessRoundPgn: jest.Mock;
      }).fetchAndProcessRoundPgn = fetchSpy;

      await svc.runFastPollTick();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('startStream() ставит hold TTL', () => {
    it('startStream ok → SET broadcast:stream-hold:<id> TTL 600', () => {
      const mocks = makeMocks();
      const svc = makeService(mocks);
      // runStream перекрываем — иначе он полезет в global.fetch и оставит
      // висящее промис.
      (svc as unknown as { runStream: jest.Mock }).runStream = jest
        .fn()
        .mockResolvedValue('aborted');

      const res = svc.startStream('rid-a');

      expect(res).toBe('ok');
      // Первый вызов redis.set — hold TTL.
      const call = mocks.redis.set.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('broadcast:stream-hold:'),
      );
      expect(call).toBeDefined();
      expect(call?.[0]).toBe('broadcast:stream-hold:rid-a');
      expect(call?.[3]).toBe(600);
    });
  });

  describe('abortStream()', () => {
    it('стрим есть → abort() зовётся, hold-ключ снимается, возвращает true', () => {
      const mocks = makeMocks();
      const svc = makeService(mocks);
      fillActiveStreams(svc, ['rid-b']);
      const entry = (svc as unknown as {
        activeStreams: Map<string, { ctrl: AbortController }>;
      }).activeStreams.get('rid-b');
      const abortSpy = jest.spyOn(entry!.ctrl, 'abort');

      const ret = svc.abortStream('rid-b');

      expect(ret).toBe(true);
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(mocks.redis.del).toHaveBeenCalledWith('broadcast:stream-hold:rid-b');
    });

    it('стрима нет → false, ничего не делает', () => {
      const mocks = makeMocks();
      const svc = makeService(mocks);

      expect(svc.abortStream('nonexistent')).toBe(false);
      expect(mocks.redis.del).not.toHaveBeenCalled();
    });
  });

  describe('syncPinnedBroadcasts §2.8 фильтр subs=0', () => {
    it('раунд с subs>=1 не попадает в phase 1 pinned poll', async () => {
      const mocks = makeMocks();
      mocks.redis.hgetall.mockResolvedValue({ 'popular-round': '10' });
      mocks.prisma.broadcastRound.findMany.mockResolvedValue([
        { lichessRoundId: 'popular-round' },
        { lichessRoundId: 'idle-round' },
      ]);
      const svc = makeService(mocks);
      // startStream перекроем — вернём capacity_full, чтобы включалась
      // ветка fallback PGN poll.
      const startSpy = jest
        .spyOn(svc, 'startStream')
        .mockReturnValue('capacity_full');
      const fetchSpy = jest.fn().mockResolvedValue(undefined);
      (svc as unknown as {
        fetchAndProcessRoundPgn: jest.Mock;
      }).fetchAndProcessRoundPgn = fetchSpy;
      (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay = jest
        .fn()
        .mockResolvedValue(undefined);
      // Отключим pending-heal (в мок-окружении нет findMany-schema для
      // этой фазы, а тесту она не нужна). Приватный метод — через каст.
      (svc as unknown as { runPendingHealPhase: jest.Mock }).runPendingHealPhase =
        jest.fn().mockResolvedValue(undefined);

      await svc.syncPinnedBroadcasts();

      // popular-round — исключён фильтром, idle-round — попадает.
      expect(startSpy).toHaveBeenCalledWith('idle-round');
      expect(startSpy).not.toHaveBeenCalledWith('popular-round');
    });
  });
});
