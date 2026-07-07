/**
 * KS-4832 / ADR-155 §3 п.3. Юнит-тесты pending-heal фазы pinned-цикла.
 *
 * Покрытие:
 *  1) выборка pending-кандидатов по окну [-24 ч, +15 мин] по startsAt;
 *  2) переход pending → ongoing при metadata.round.ongoing === true;
 *  3) переход pending → finished при metadata.round.finished === true;
 *  4) cooldown 60 сек — второй вызов в текущий цикл skip'ается;
 *  5) квота — не больше BROADCAST_MAX_PENDING_CHECKS за цикл;
 *  6) 404 → not_found (status не меняется), cooldown ставится;
 *  7) ошибка → err, cooldown ставится, status не меняется;
 *  8) метрика promotion delay считается от startsAt.
 *
 * Мокаем PrismaService, RedisService, SyncMetricsService,
 * BroadcastStandingsSyncService, PrerenderEnqueueService. lichessFetch и
 * rateLimitDelay перезаписываем как spy на инстансе — оба приватные.
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

type RoundRow = {
  id: string;
  lichessRoundId: string;
  startsAt: Date | null;
  broadcastId: string;
  status: 'pending' | 'ongoing' | 'finished' | 'failed';
};

interface Mocks {
  prisma: {
    broadcastRound: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  redis: {
    get: jest.Mock;
    set: jest.Mock;
  };
  metrics: Record<string, jest.Mock>;
  standingsSync: object;
  prerender: {
    enqueueFireAndForget: jest.Mock;
  };
  lichessFetch: jest.Mock;
  rateLimitDelay: jest.Mock;
}

function makeService(mocks: Mocks): BroadcastSyncService {
  const svc = new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
  // Приватные методы перекрываем на инстансе — типизировано через any.
  (svc as unknown as { lichessFetch: jest.Mock }).lichessFetch =
    mocks.lichessFetch;
  (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay =
    mocks.rateLimitDelay;
  return svc;
}

function makeMocks(): Mocks {
  return {
    prisma: {
      broadcastRound: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    },
    redis: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    },
    metrics: {
      recordPendingCheck: jest.fn(),
      observePendingPromotionDelay: jest.fn(),
      recordLichessRequest: jest.fn(),
    },
    standingsSync: {},
    prerender: {
      enqueueFireAndForget: jest.fn(),
    },
    lichessFetch: jest.fn(),
    rateLimitDelay: jest.fn().mockResolvedValue(undefined),
  };
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function round(overrides: Partial<RoundRow> = {}): RoundRow {
  return {
    id: overrides.id ?? '11111111-1111-4111-a111-111111111111',
    lichessRoundId: overrides.lichessRoundId ?? 'abcd1234',
    // `??` пропускает null → используем hasOwnProperty, чтобы null-override сработал.
    startsAt: Object.prototype.hasOwnProperty.call(overrides, 'startsAt')
      ? overrides.startsAt!
      : new Date(Date.now() - 5 * 60 * 1000),
    broadcastId: overrides.broadcastId ?? '22222222-2222-4222-a222-222222222222',
    status: overrides.status ?? 'pending',
  };
}

describe('BroadcastSyncService.runPendingHealPhase — KS-4832 / ADR-155', () => {
  it('выбирает pending-кандидатов по окну [-24ч, +15мин] от NOW', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([]);
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.findMany).toHaveBeenCalledTimes(1);
    const args = mocks.prisma.broadcastRound.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('pending');
    const { gte, lte } = args.where.startsAt as { gte: Date; lte: Date };
    const now = Date.now();
    // gte ≈ NOW - 24h; lte ≈ NOW + 15min. Допуск ±2 сек на выполнение.
    expect(now - gte.getTime()).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 2000);
    expect(now - gte.getTime()).toBeLessThanOrEqual(24 * 3600 * 1000 + 2000);
    expect(lte.getTime() - now).toBeGreaterThanOrEqual(15 * 60 * 1000 - 2000);
    expect(lte.getTime() - now).toBeLessThanOrEqual(15 * 60 * 1000 + 2000);
  });

  it('promotes pending → ongoing при metadata.round.ongoing = true', async () => {
    const mocks = makeMocks();
    const r = round({ startsAt: new Date(Date.now() - 60 * 1000) });
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: true, finished: false } }),
    );
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.update).toHaveBeenCalledWith({
      where: { id: r.id },
      data: { status: 'ongoing' },
    });
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith('promoted');
    expect(mocks.prerender.enqueueFireAndForget).toHaveBeenCalledWith({
      kind: 'broadcast',
      tid: r.broadcastId,
      rid: r.id,
    });
    // Cooldown-ключ ставится
    expect(mocks.redis.set).toHaveBeenCalledWith(
      `broadcast:pending-check-cooldown:${r.lichessRoundId}`,
      '1',
      'EX',
      60,
    );
    // Задержка промоушена ≈ 60 сек (наблюдение выполнено)
    expect(mocks.metrics.observePendingPromotionDelay).toHaveBeenCalledTimes(1);
    const delayArg =
      mocks.metrics.observePendingPromotionDelay.mock.calls[0][0];
    expect(delayArg).toBeGreaterThanOrEqual(59);
    expect(delayArg).toBeLessThanOrEqual(62);
    // KS-4859 / ADR-159 §3.1 п.2. Раньше pending-heal при промоушене
    // сразу вызывал `startStream()`. Стримов больше нет — live-данные
    // подхватит fast poll (subs≥1) или slow pinned poll (subs=0).
  });

  it('promotes pending → finished при metadata.round.finished = true', async () => {
    const mocks = makeMocks();
    const r = round();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: false, finished: true } }),
    );
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.update).toHaveBeenCalledWith({
      where: { id: r.id },
      data: { status: 'finished' },
    });
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith('promoted');
    // KS-4859 / ADR-159 §3.1 п.2. Стримов больше нет — проверка на
    // «startStream не вызывался» бесполезна.
  });

  it('still_pending при ongoing=false, finished=false — status не меняется', async () => {
    const mocks = makeMocks();
    const r = round();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: false, finished: false } }),
    );
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.update).not.toHaveBeenCalled();
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith(
      'still_pending',
    );
    // Cooldown ставится независимо от исхода
    expect(mocks.redis.set).toHaveBeenCalledTimes(1);
  });

  it('404 → not_found, status не меняется, cooldown ставится', async () => {
    const mocks = makeMocks();
    const r = round();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockResolvedValue(makeResponse(404, {}));
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.update).not.toHaveBeenCalled();
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith('not_found');
    expect(mocks.redis.set).toHaveBeenCalledTimes(1);
  });

  it('сетевая ошибка → err, status не меняется, cooldown ставится', async () => {
    const mocks = makeMocks();
    const r = round();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockRejectedValue(new Error('ECONNRESET'));
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.prisma.broadcastRound.update).not.toHaveBeenCalled();
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith('err');
    expect(mocks.redis.set).toHaveBeenCalledTimes(1);
  });

  it('cooldown-ключ есть в Redis → раунд skip, lichessFetch не зовётся', async () => {
    const mocks = makeMocks();
    const r = round();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.redis.get.mockResolvedValue('1'); // ключ занят
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.lichessFetch).not.toHaveBeenCalled();
    expect(mocks.metrics.recordPendingCheck).not.toHaveBeenCalled();
    // Cooldown НЕ переставляется (мы даже не пытались сделать запрос)
    expect(mocks.redis.set).not.toHaveBeenCalled();
  });

  it('квота: при 15 pending-кандидатах запросов ровно 10 (BROADCAST_MAX_PENDING_CHECKS default)', async () => {
    const mocks = makeMocks();
    const rounds: RoundRow[] = Array.from({ length: 15 }, (_, i) =>
      round({
        id: `11111111-1111-4111-a111-1111111111${String(i).padStart(2, '0')}`,
        lichessRoundId: `round${i.toString().padStart(2, '0')}`,
      }),
    );
    mocks.prisma.broadcastRound.findMany.mockResolvedValue(rounds);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: false, finished: false } }),
    );
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.lichessFetch).toHaveBeenCalledTimes(10);
    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledTimes(10);
  });

  it('пустой список кандидатов → ни fetch, ни update, ни метрики', async () => {
    const mocks = makeMocks();
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([]);
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.lichessFetch).not.toHaveBeenCalled();
    expect(mocks.prisma.broadcastRound.update).not.toHaveBeenCalled();
    expect(mocks.metrics.recordPendingCheck).not.toHaveBeenCalled();
  });

  it('round.startsAt=null → promotion delay не наблюдается (защита от NaN)', async () => {
    const mocks = makeMocks();
    const r = round({ startsAt: null });
    mocks.prisma.broadcastRound.findMany.mockResolvedValue([r]);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: true } }),
    );
    const svc = makeService(mocks);

    await svc.runPendingHealPhase();

    expect(mocks.metrics.recordPendingCheck).toHaveBeenCalledWith('promoted');
    expect(mocks.metrics.observePendingPromotionDelay).not.toHaveBeenCalled();
  });
});
