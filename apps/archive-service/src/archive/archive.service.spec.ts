import type { ArchiveBucket, ArchiveTreeResponse } from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveController } from './archive.controller';
import { ArchiveMetricsService } from './archive-metrics.service';
import {
  ArchiveStatsRepository,
  GamesByPositionOpts,
  GamesByPositionPage,
  TreeOpts,
} from './archive-stats.repository';

/** Minimal in-memory Redis double implementing only the methods the service uses. */
class FakeRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async keys(pattern: string): Promise<string[]> {
    // Only supports the exact `arch:tree:*` pattern used by the service.
    if (pattern === 'arch:tree:*') {
      return [...this.store.keys()].filter((k) => k.startsWith('arch:tree:'));
    }
    return [...this.store.keys()];
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.store.delete(k)) removed++;
    }
    return removed;
  }

  // Service calls redis.duplicate().subscribe(...) in onModuleInit. We don't
  // run onModuleInit in these unit tests, so these stubs are unused — but
  // kept to document the surface.
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(_channel: string): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async quit(): Promise<void> {}
  on(_event: string, _cb: (...args: unknown[]) => void): void {}
}

/** Mock repository that records calls so tests can assert dispatch. */
class MockStatsRepository implements ArchiveStatsRepository {
  public calls: Array<{ posKey: Buffer; opts: TreeOpts }> = [];

  constructor(private readonly response: ArchiveTreeResponse) {}

  async getTree(posKey: Buffer, opts: TreeOpts): Promise<ArchiveTreeResponse> {
    this.calls.push({ posKey, opts });
    return { ...this.response, fen: opts.fen };
  }

  // Stubs for the new surface — not exercised by the tree-path tests
  // below; a dedicated spec (or future integration test) will cover them.
  async getGamesByPosition(
    _posKey: Buffer,
    _opts: GamesByPositionOpts,
  ): Promise<GamesByPositionPage> {
    return { items: [], overflow: null };
  }
  async countApprox(_posKey: Buffer, _bucket: ArchiveBucket): Promise<number> {
    return 0;
  }
  async listTopPositions(
    _bucket: ArchiveBucket,
    _limit: number,
  ): Promise<Array<{ positionKey: Buffer; total: number }>> {
    return [];
  }
  async searchGames(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
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
  async searchPlayerGames(): Promise<{ total: number; items: never[] }> {
    return { total: 0, items: [] };
  }
}

const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function buildResponse(overrides: Partial<ArchiveTreeResponse> = {}): ArchiveTreeResponse {
  return {
    fen: startFen,
    positionKey: '00'.repeat(16),
    totalGames: 3,
    moves: [
      {
        uci: 'e2e4',
        san: 'e4',
        total: 2,
        whiteWins: 1,
        draws: 1,
        blackWins: 0,
        whitePct: 50,
        drawPct: 50,
        blackPct: 0,
        avgElo: 2500,
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
      {
        uci: 'd2d4',
        san: 'd4',
        total: 1,
        whiteWins: 0,
        draws: 0,
        blackWins: 1,
        whitePct: 0,
        drawPct: 0,
        blackPct: 100,
        avgElo: 2400,
        lastSeenAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    opening: null,
    ...overrides,
  };
}

function makeService(repo: ArchiveStatsRepository, redis: FakeRedis, metrics: ArchiveMetricsService) {
  // PrismaService is not used by the code paths under test (tree path).
  const prisma = {} as never;
  return new ArchiveService(prisma, redis as never, metrics, repo);
}

describe('ArchiveService — tree cache + repository injection', () => {
  it('serves the second call from Redis (cache_hit=true) without hitting the repo', async () => {
    const repo = new MockStatsRepository(buildResponse());
    const redis = new FakeRedis();
    const metrics = new ArchiveMetricsService();
    const svc = makeService(repo, redis, metrics);

    const first = await svc.getTree({ fen: startFen });
    const second = await svc.getTree({ fen: startFen });

    expect(first).toEqual(second);
    expect(repo.calls.length).toBe(1); // second call served from cache

    const snap = metrics.snapshot();
    expect(snap.cacheMisses).toBe(1);
    expect(snap.cacheHits).toBe(1);
    expect(snap.cacheHitRatio).toBeCloseTo(0.5, 5);
  });

  it('uses different cache entries per bucket and filter combination', async () => {
    const repo = new MockStatsRepository(buildResponse());
    const redis = new FakeRedis();
    const metrics = new ArchiveMetricsService();
    const svc = makeService(repo, redis, metrics);

    await svc.getTree({ fen: startFen, bucket: 'master' });
    await svc.getTree({ fen: startFen, bucket: 'user' });
    await svc.getTree({ fen: startFen, bucket: 'master', minElo: 2400 });

    expect(repo.calls.length).toBe(3); // every distinct filter reaches the repo
  });

  it('returns an empty tree when the repo has no data', async () => {
    const repo = new MockStatsRepository(
      buildResponse({ totalGames: 0, moves: [] }),
    );
    const svc = makeService(repo, new FakeRedis(), new ArchiveMetricsService());

    const res = await svc.getTree({ fen: startFen });
    expect(res.totalGames).toBe(0);
    expect(res.moves).toEqual([]);
  });

  it('ArchiveController works unchanged when the repository is swapped (ADR §10.C.4)', async () => {
    const repo = new MockStatsRepository(buildResponse());
    const svc = makeService(repo, new FakeRedis(), new ArchiveMetricsService());
    const controller = new ArchiveController(svc);

    const response = await controller.getTree({ fen: startFen } as never);
    expect(response.totalGames).toBe(3);
    expect(response.moves[0].san).toBe('e4');
    expect(repo.calls.length).toBe(1);
  });
});
