/**
 * KS-2154. Поведенческий тест staggered-инвалидации после `archive:imported`.
 *
 * Смысл фикса: один TWIC-импорт инвалидирует ≥60 cache entries; раньше всё
 * летело одним DEL → следующие cold-запросы пользователей одновременно
 * били в archive-db, пул `connection_limit=20` исчерпывался. Теперь
 * каждый паттерн `arch:*:*` режется на батчи и удаляется с паузами.
 */
import { ArchiveService } from './archive.service';
import { ArchiveMetricsService } from './archive-metrics.service';
import {
  ArchiveStatsRepository,
  GamesByPositionOpts,
  GamesByPositionPage,
  TreeOpts,
} from './archive-stats.repository';
import type { ArchiveBucket, ArchiveTreeResponse } from '@kingside/shared';

class FakeRedis {
  private store = new Map<string, string>();
  public delCalls: string[][] = [];

  seed(prefix: string, count: number): void {
    for (let i = 0; i < count; i++) {
      this.store.set(`${prefix}${i}`, '{}');
    }
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(): Promise<'OK'> {
    return 'OK';
  }
  async keys(pattern: string): Promise<string[]> {
    // Поддерживаем `prefix:*` — только глоб в конце, как использует сервис.
    const m = /^(.*):\*$/.exec(pattern);
    if (!m) return [];
    const prefix = `${m[1]}:`;
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
  async del(...keys: string[]): Promise<number> {
    this.delCalls.push([...keys]);
    let removed = 0;
    for (const k of keys) {
      if (this.store.delete(k)) removed++;
    }
    return removed;
  }
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async quit(): Promise<void> {}
  on(): void {}
}

class StubRepo implements ArchiveStatsRepository {
  async getTree(_k: Buffer, opts: TreeOpts): Promise<ArchiveTreeResponse> {
    return {
      fen: opts.fen,
      positionKey: '00'.repeat(16),
      totalGames: 0,
      moves: [],
      opening: null,
    };
  }
  async getGamesByPosition(
    _k: Buffer,
    _o: GamesByPositionOpts,
  ): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_k: Buffer, _b: ArchiveBucket): Promise<number> {
    return 0;
  }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> {
    return [];
  }
  async searchGames(): Promise<{ total: number; hasNext: boolean; items: never[] }> {
    return { total: 0, hasNext: false, items: [] };
  }
  async searchPlayers(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
  async searchEvents(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
  async getPlayerProfile(): Promise<null> {
    return null;
  }
  async searchPlayerGames(): Promise<{ total: number; hasNext: boolean; items: never[] }> {
    return { total: 0, hasNext: false, items: [] };
  }
}

function makeService(redis: FakeRedis): ArchiveService {
  const prisma = {} as never;
  return new ArchiveService(
    prisma,
    redis as never,
    new ArchiveMetricsService(),
    new StubRepo(),
  );
}

describe('ArchiveService — staggered cache invalidation (KS-2154)', () => {
  it('uses bulk DEL when keys count is ≤ threshold', async () => {
    const redis = new FakeRedis();
    redis.seed('arch:tree:', 5); // ≤ 10 → bulk
    const svc = makeService(redis);
    const logSpy = jest
      .spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);

    await (
      svc as unknown as {
        invalidateByPattern(pattern: string, label: string): Promise<void>;
      }
    ).invalidateByPattern('arch:tree:*', 'archive tree');

    // Все 5 ключей удалены одним DEL.
    expect(redis.delCalls).toHaveLength(1);
    expect(redis.delCalls[0]).toHaveLength(5);

    const logged = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logged).toMatch(/Invalidated 5 archive tree cache entries/);
    expect(logged).toMatch(/mode=bulk/);
    expect(logged).toMatch(/durationMs=\d+/);
  });

  it('uses staggered DEL with pauses between batches when keys count > threshold', async () => {
    jest.useFakeTimers();
    try {
      const redis = new FakeRedis();
      redis.seed('arch:games:', 25); // > 10 → staggered, 3 батча по 10/10/5
      const svc = makeService(redis);
      const logSpy = jest
        .spyOn(
          (svc as unknown as { logger: { log: (m: string) => void } }).logger,
          'log',
        )
        .mockImplementation(() => undefined);

      const pending = (
        svc as unknown as {
          invalidateByPattern(pattern: string, label: string): Promise<void>;
        }
      ).invalidateByPattern('arch:games:*', 'games-by-position');

      // Первый батч (10 ключей) удаляется до первого setTimeout.
      await Promise.resolve();
      await Promise.resolve();
      expect(redis.delCalls).toHaveLength(1);
      expect(redis.delCalls[0]).toHaveLength(10);

      // Сдвигаемся через первую паузу — должен пойти второй батч.
      await jest.advanceTimersByTimeAsync(1500);
      expect(redis.delCalls.length).toBeGreaterThanOrEqual(2);
      expect(redis.delCalls[1]).toHaveLength(10);

      // Сдвигаемся через вторую паузу — третий батч (5 ключей).
      await jest.advanceTimersByTimeAsync(1500);
      await pending;

      expect(redis.delCalls).toHaveLength(3);
      expect(redis.delCalls[2]).toHaveLength(5);

      const logged = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(logged).toMatch(/Invalidated 25 games-by-position cache entries/);
      expect(logged).toMatch(/mode=staggered/);
      expect(logged).toMatch(/batch=10/);
      expect(logged).toMatch(/intervalMs=1500/);
      expect(logged).toMatch(/durationMs=\d+/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing (no log, no DEL) when no keys match', async () => {
    const redis = new FakeRedis();
    const svc = makeService(redis);
    const logSpy = jest
      .spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);

    await (
      svc as unknown as {
        invalidateByPattern(pattern: string, label: string): Promise<void>;
      }
    ).invalidateByPattern('arch:tree:*', 'archive tree');

    expect(redis.delCalls).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
