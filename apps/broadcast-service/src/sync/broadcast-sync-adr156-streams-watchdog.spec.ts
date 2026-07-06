/**
 * KS-4842. Юнит-тесты сторожевого таймера и плановой ротации стримов.
 *
 * Покрытие:
 *  - `checkStreamsWatchdog` абортит стрим с молчанием > порога, ставит
 *    метку `watchdogStale`.
 *  - `checkStreamsWatchdog` не трогает свежие стримы.
 *  - `rotateActiveStreams` абортит все, метки `rotation`.
 *  - `startStream` завершение с меткой `watchdogStale` → метрика
 *    `recordStreamEnded('watchdog_stale')`.
 *  - `startStream` завершение с меткой `rotation` → `recordStreamEnded('rotation')`.
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

function makeMocks() {
  return {
    prisma: {
      broadcast: { findUnique: jest.fn() },
      broadcastRound: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    },
    redis: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    },
    metrics: {
      recordStreamStarted: jest.fn(),
      recordStreamEnded: jest.fn(),
      observeStreamDuration: jest.fn(),
      setStreamsActive: jest.fn(),
      setStreamsWatchdogMaxAge: jest.fn(),
    },
    standingsSync: {},
    prerender: { enqueueFireAndForget: jest.fn() },
  };
}

function makeService(mocks: ReturnType<typeof makeMocks>): BroadcastSyncService {
  const svc = new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
  // runStream перекрываем — иначе полезет в глобальный fetch. Тесты
  // проверяют механику watchdog/rotation, а не сам сетевой цикл.
  (svc as unknown as { runStream: jest.Mock }).runStream = jest
    .fn()
    .mockResolvedValue('aborted');
  return svc;
}

type StreamEntry = {
  ctrl: AbortController;
  lastByteAt: number;
  watchdogStale?: boolean;
  rotation?: boolean;
};

function getActiveStreams(svc: BroadcastSyncService): Map<string, StreamEntry> {
  return (svc as unknown as { activeStreams: Map<string, StreamEntry> })
    .activeStreams;
}

function callWatchdog(svc: BroadcastSyncService): void {
  (svc as unknown as { checkStreamsWatchdog(): void }).checkStreamsWatchdog();
}

function callRotate(svc: BroadcastSyncService): void {
  (svc as unknown as { rotateActiveStreams(): void }).rotateActiveStreams();
}

describe('BroadcastSyncService streams watchdog + rotation — KS-4842', () => {
  it('watchdog абортит стрим с молчанием > 90 сек и ставит watchdogStale', () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    svc.startStream('roundStale');

    const active = getActiveStreams(svc);
    const entry = active.get('roundStale');
    expect(entry).toBeDefined();
    // Симулируем молчание 100 сек — сдвигаем lastByteAt в прошлое.
    entry!.lastByteAt = Date.now() - 100_000;
    const abortSpy = jest.spyOn(entry!.ctrl, 'abort');

    callWatchdog(svc);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(entry!.watchdogStale).toBe(true);
  });

  it('watchdog не трогает свежий стрим (lastByteAt только что)', () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    svc.startStream('roundFresh');

    const entry = getActiveStreams(svc).get('roundFresh')!;
    const abortSpy = jest.spyOn(entry.ctrl, 'abort');

    callWatchdog(svc);

    expect(abortSpy).not.toHaveBeenCalled();
    expect(entry.watchdogStale).toBeUndefined();
  });

  it('rotation абортит все активные стримы и ставит метки rotation', () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    svc.startStream('r1');
    svc.startStream('r2');
    svc.startStream('r3');

    const active = getActiveStreams(svc);
    const spies = ['r1', 'r2', 'r3'].map((r) =>
      jest.spyOn(active.get(r)!.ctrl, 'abort'),
    );

    callRotate(svc);

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    for (const r of ['r1', 'r2', 'r3']) {
      expect(active.get(r)!.rotation).toBe(true);
    }
  });

  it('rotation с пустой Map — no-op, без ошибок', () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    expect(() => callRotate(svc)).not.toThrow();
  });

  it('завершение стрима с меткой watchdogStale → recordStreamEnded("watchdog_stale")', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    // runStream перекрыт — вернёт 'aborted', watchdogStale переопределит.
    svc.startStream('roundWD');
    const entry = getActiveStreams(svc).get('roundWD')!;
    entry.watchdogStale = true;
    // Дать промису из startStream разрешиться.
    await new Promise((r) => setImmediate(r));

    expect(mocks.metrics.recordStreamEnded).toHaveBeenCalledWith(
      'watchdog_stale',
    );
  });

  it('завершение стрима с меткой rotation → recordStreamEnded("rotation")', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    svc.startStream('roundR');
    const entry = getActiveStreams(svc).get('roundR')!;
    entry.rotation = true;
    await new Promise((r) => setImmediate(r));

    expect(mocks.metrics.recordStreamEnded).toHaveBeenCalledWith('rotation');
  });

  it('без меток → recordStreamEnded с собственной причиной runStream (aborted)', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    svc.startStream('roundN');
    // Не ставим ни watchdogStale, ни rotation.
    await new Promise((r) => setImmediate(r));

    expect(mocks.metrics.recordStreamEnded).toHaveBeenCalledWith('aborted');
  });
});
