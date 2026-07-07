/**
 * KS-4832 / ADR-156 §5. Юнит-тесты трёх новых механик:
 *  - `refreshNonTop20RoundStatuses`: приоритетная сортировка (ongoing →
 *    pending → finished), Redis-cursor, квота.
 *  - `startStream()`: маркер `ok` / `capacity_full` / `already_active` /
 *    `error`, инкремент `broadcast_streams_started_total` по исходу.
 *  - `syncPinnedBroadcasts` phase 1: перед PGN poll вызывается
 *    `startStream`, при `ok`/`already_active` PGN poll пропускается.
 *
 * Как и в spec-файле pending-heal — мокаем PrismaService/RedisService/
 * SyncMetricsService/BroadcastStandingsSyncService/PrerenderEnqueueService.
 * `lichessFetch` и `rateLimitDelay` перекрываем как spy на инстансе.
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

interface Mocks {
  prisma: {
    broadcast: { findUnique: jest.Mock };
    broadcastRound: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
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

function makeMocks(): Mocks {
  return {
    prisma: {
      broadcast: { findUnique: jest.fn() },
      broadcastRound: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    },
    redis: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    },
    metrics: {
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

function makeService(mocks: Mocks): BroadcastSyncService {
  const svc = new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
  (svc as unknown as { lichessFetch: jest.Mock }).lichessFetch =
    mocks.lichessFetch;
  (svc as unknown as { rateLimitDelay: jest.Mock }).rateLimitDelay =
    mocks.rateLimitDelay;
  // runStream перекрываем no-op — иначе полезет в глобальный fetch и
  // оставит открытый AbortController после теста (Jest worker leak).
  (svc as unknown as { runStream: jest.Mock }).runStream = jest
    .fn()
    .mockResolvedValue('aborted');
  return svc;
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// KS-4859 / ADR-159 §2.3, §3.1 п.1. Метод `startStream()` удалён
// (backend больше не открывает SSE к Lichess). Существовавшие здесь
// тесты `startStream` — `'ok'`/`'already_active'`/`'capacity_full'` —
// сняты вместе с методом.

describe('BroadcastSyncService.refreshNonTop20RoundStatuses — KS-4832 / ADR-156', () => {
  function makeRounds(
    entries: Array<{
      idx: number;
      status: 'ongoing' | 'pending' | 'finished';
    }>,
  ) {
    return entries.map((e) => ({
      id: `id-${e.idx.toString().padStart(4, '0')}`,
      lichessRoundId: `lich${e.idx.toString().padStart(4, '0')}`,
      status: e.status,
    }));
  }

  it('приоритет ongoing → pending → finished в пределах квоты', async () => {
    const mocks = makeMocks();
    // 3 finished, 2 pending, 1 ongoing. Квота 3 — берём ongoing+2 pending.
    const rounds = [
      ...makeRounds([
        { idx: 1, status: 'finished' },
        { idx: 2, status: 'finished' },
        { idx: 3, status: 'finished' },
        { idx: 4, status: 'pending' },
        { idx: 5, status: 'pending' },
        { idx: 6, status: 'ongoing' },
      ]),
    ];
    mocks.prisma.broadcastRound.findMany.mockResolvedValue(rounds);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: false, finished: false } }),
    );
    // Читаем константу квоты через env — прогоним при default=50 не подходит
    // (все 6 попадут). Задаём временно 3 через override приватной константы —
    // не можем, значит используем 6 раундов + проверяем ORDER первых.
    const svc = makeService(mocks);
    await (
      svc as unknown as {
        refreshNonTop20RoundStatuses(s: Set<string>): Promise<void>;
      }
    ).refreshNonTop20RoundStatuses(new Set());
    // Первые запросы (порядок вызова lichessFetch) — ongoing, потом pending,
    // потом finished.
    const urls = mocks.lichessFetch.mock.calls.map(
      (c: [string, unknown]) => c[0],
    );
    expect(urls[0]).toContain('lich0006'); // ongoing
    expect(urls[1]).toContain('lich0004'); // pending #1
    expect(urls[2]).toContain('lich0005'); // pending #2
    expect(urls[3]).toContain('lich0001'); // finished #1
  });

  it('cursor сохраняется в Redis и сбрасывается при достижении конца', async () => {
    const mocks = makeMocks();
    // 3 раунда, квота 50 (default) — все укладываются, cursor должен быть 0
    // (сброс, потому что дошли до конца выборки).
    const rounds = makeRounds([
      { idx: 1, status: 'ongoing' },
      { idx: 2, status: 'ongoing' },
      { idx: 3, status: 'ongoing' },
    ]);
    mocks.prisma.broadcastRound.findMany.mockResolvedValue(rounds);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: true } }),
    );
    const svc = makeService(mocks);
    await (
      svc as unknown as {
        refreshNonTop20RoundStatuses(s: Set<string>): Promise<void>;
      }
    ).refreshNonTop20RoundStatuses(new Set());
    expect(mocks.redis.set).toHaveBeenCalledWith(
      'broadcast:refresh:cursor',
      '0',
      'EX',
      3600,
    );
  });

  it('cursor из Redis читается и используется как offset', async () => {
    const mocks = makeMocks();
    mocks.redis.get.mockResolvedValue('2');
    // 5 ongoing раундов, cursor=2 → берём начиная с индекса 2 (lich0003).
    const rounds = makeRounds([
      { idx: 1, status: 'ongoing' },
      { idx: 2, status: 'ongoing' },
      { idx: 3, status: 'ongoing' },
      { idx: 4, status: 'ongoing' },
      { idx: 5, status: 'ongoing' },
    ]);
    mocks.prisma.broadcastRound.findMany.mockResolvedValue(rounds);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: true } }),
    );
    const svc = makeService(mocks);
    await (
      svc as unknown as {
        refreshNonTop20RoundStatuses(s: Set<string>): Promise<void>;
      }
    ).refreshNonTop20RoundStatuses(new Set());
    const urls = mocks.lichessFetch.mock.calls.map(
      (c: [string, unknown]) => c[0],
    );
    // Первый запрос — с индекса 2 (lich0003).
    expect(urls[0]).toContain('lich0003');
  });

  it('исключаются раунды из upsertedRoundIds', async () => {
    const mocks = makeMocks();
    const rounds = makeRounds([
      { idx: 1, status: 'ongoing' },
      { idx: 2, status: 'ongoing' },
      { idx: 3, status: 'ongoing' },
    ]);
    mocks.prisma.broadcastRound.findMany.mockResolvedValue(rounds);
    mocks.lichessFetch.mockResolvedValue(
      makeResponse(200, { round: { ongoing: true } }),
    );
    const svc = makeService(mocks);
    await (
      svc as unknown as {
        refreshNonTop20RoundStatuses(s: Set<string>): Promise<void>;
      }
    ).refreshNonTop20RoundStatuses(new Set(['lich0002']));
    const urls = mocks.lichessFetch.mock.calls.map(
      (c: [string, unknown]) => c[0],
    );
    // lich0002 исключён, должны быть только 0001 и 0003.
    expect(urls.some((u: string) => u.includes('lich0001'))).toBe(true);
    expect(urls.some((u: string) => u.includes('lich0003'))).toBe(true);
    expect(urls.some((u: string) => u.includes('lich0002'))).toBe(false);
  });
});
