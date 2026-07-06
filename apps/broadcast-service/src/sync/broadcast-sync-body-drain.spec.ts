/**
 * KS-4845. Тесты дренажа `res.body` в error-ветках `lichessFetch` и
 * `runStream`.
 *
 * Контекст (см. KS-4841): если ответ fetch не прочитан до конца и не
 * отменён через `res.body.cancel()`, undici держит TCP-соединение в
 * состоянии waiting-for-body — оно НЕ возвращается в keep-alive pool.
 * Через несколько сотен утечек pool исчерпан, новые connect() висят
 * до 30-сек таймаута — массовые ETIMEDOUT.
 *
 * Что проверяем:
 *  1. `lichessFetch` — при 429 `res.body.cancel()` вызывается до throw.
 *  2. `runStream` — при 429 `res.body.cancel()` вызывается до return.
 *  3. `runStream` — при 500 (`!res.ok`) `res.body.cancel()` вызывается
 *     до throw (retry loop затем закрывается через abort/stop).
 */
import { BroadcastSyncService } from './broadcast-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { SyncMetricsService } from './sync-metrics';
import type { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

interface Mocks {
  prisma: object;
  redis: object;
  metrics: object;
  standingsSync: object;
  prerender: object;
}

function makeService(mocks: Mocks): BroadcastSyncService {
  return new BroadcastSyncService(
    mocks.prisma as unknown as PrismaService,
    mocks.redis as unknown as RedisService,
    mocks.metrics as unknown as SyncMetricsService,
    mocks.standingsSync as unknown as BroadcastStandingsSyncService,
    mocks.prerender as unknown as PrerenderEnqueueService,
  );
}

function makeMocks(): Mocks {
  // KS-4846. У сервиса добавились новые вызовы метрик (recordLichessRequest
  // и compania) — держим stub всех методов, чтобы драйно тестам этого спека
  // не приходилось знать всю поверхность SyncMetricsService.
  return {
    prisma: {},
    redis: {},
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

/**
 * Строит Response-совместимый объект с `body.cancel` = jest.fn().
 * Возвращаем шпион отдельно, чтобы удобно проверять факт вызова.
 */
function makeResponseWithBody(
  status: number,
): { res: Response; cancelSpy: jest.Mock } {
  const cancelSpy = jest.fn().mockResolvedValue(undefined);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: cancelSpy },
  } as unknown as Response;
  return { res, cancelSpy };
}

describe('KS-4845 — дренаж res.body в error-ветках', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('lichessFetch', () => {
    it('429 → res.body.cancel() вызван до throw', async () => {
      const svc = makeService(makeMocks());
      const { res, cancelSpy } = makeResponseWithBody(429);
      global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;

      await expect(
        (
          svc as unknown as {
            lichessFetch: (u: string) => Promise<Response>;
          }
        ).lichessFetch('https://lichess.org/api/broadcast/-/-/abcd1234'),
      ).rejects.toThrow('Lichess 429 Too Many Requests');

      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('200 OK → body.cancel не вызывается (тело возвращается вызывающему)', async () => {
      const svc = makeService(makeMocks());
      const { res, cancelSpy } = makeResponseWithBody(200);
      global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;

      const out = await (
        svc as unknown as {
          lichessFetch: (u: string) => Promise<Response>;
        }
      ).lichessFetch('https://lichess.org/api/broadcast/-/-/abcd1234');

      expect(out.status).toBe(200);
      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  describe('runStream', () => {
    it('429 → res.body.cancel() вызван, вернулся rate_limit_429', async () => {
      const mocks = makeMocks();
      const svc = makeService(mocks);
      const { res, cancelSpy } = makeResponseWithBody(429);
      global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;

      const ctrl = new AbortController();
      const reason = await (
        svc as unknown as {
          runStream: (
            id: string,
            sig: AbortSignal,
          ) => Promise<'rate_limit_429' | 'aborted' | 'error' | 'round_finished'>;
        }
      ).runStream('rid1234', ctrl.signal);

      expect(reason).toBe('rate_limit_429');
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('500 → res.body.cancel() вызван, retry-loop прерывается по abort', async () => {
      const svc = makeService(makeMocks());
      const { res, cancelSpy } = makeResponseWithBody(500);
      global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;

      const ctrl = new AbortController();
      // После первого фетча — сразу abort, чтобы не крутить retry-loop.
      // `sleep` в runStream уважает signal и вернёт управление, цикл
      // выйдет с 'aborted'.
      (svc as unknown as { sleep: jest.Mock }).sleep = jest
        .fn()
        .mockImplementation(async () => {
          ctrl.abort();
        });

      const reason = await (
        svc as unknown as {
          runStream: (
            id: string,
            sig: AbortSignal,
          ) => Promise<'rate_limit_429' | 'aborted' | 'error' | 'round_finished'>;
        }
      ).runStream('rid1234', ctrl.signal);

      expect(reason).toBe('aborted');
      // cancel вызывается ровно в !res.ok ветке (до throw).
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
  });
});
