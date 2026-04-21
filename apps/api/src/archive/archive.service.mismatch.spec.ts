/**
 * Тесты fail-closed guard'а в `ArchiveService.getGamesByPosition`
 * (ADR-016 §Инвариант #3 honest badge, задача KS-1634).
 *
 * Поведение: если `archive_game_positions` не отдаёт ни одной партии
 * (`items.length === 0`), а `position_stats` утверждает о `totalApprox > 0`,
 * сервис обязан:
 *   1. Залогировать warn с деталями mismatch.
 *   2. Инкрементировать метрику `archive_tree_list_mismatch_total{bucket}`.
 *   3. Вернуть ответ с `totalApprox = null` (UI покажет fallback).
 *
 * В остальных случаях ответ не трогается.
 */

import { Logger } from '@nestjs/common';
import type {
  ArchiveBucket,
  ArchiveGamesByPositionItem,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
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
    if (pattern === 'arch:tree:*') {
      return [...this.store.keys()].filter((k) => k.startsWith('arch:tree:'));
    }
    if (pattern === 'arch:games:*') {
      return [...this.store.keys()].filter((k) => k.startsWith('arch:games:'));
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
  duplicate(): FakeRedis {
    return this;
  }
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  async quit(): Promise<void> {}
  on(): void {}
}

/** Configurable repo: задаём items и totalApprox — тест проверяет, как сервис их комбинирует. */
class ConfigurableRepo implements ArchiveStatsRepository {
  public gamesCalls = 0;
  public countCalls = 0;

  constructor(
    private readonly page: GamesByPositionPage,
    private readonly totalApprox: number,
  ) {}

  async getTree(_posKey: Buffer, _opts: TreeOpts): Promise<ArchiveTreeResponse> {
    throw new Error('not used in these tests');
  }
  async getGamesByPosition(
    _posKey: Buffer,
    _opts: GamesByPositionOpts,
  ): Promise<GamesByPositionPage> {
    this.gamesCalls += 1;
    return this.page;
  }
  async countApprox(_posKey: Buffer, _bucket: ArchiveBucket): Promise<number> {
    this.countCalls += 1;
    return this.totalApprox;
  }
  async listTopPositions(): Promise<Array<{ positionKey: Buffer; total: number }>> {
    return [];
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeItem(id: string): ArchiveGamesByPositionItem {
  return {
    id,
    white: { name: 'W', elo: 2400, title: null },
    black: { name: 'B', elo: 2500, title: null },
    result: '1-0',
    eco: 'C50',
    opening: 'Italian',
    event: null,
    date: '2025-01-01T00:00:00.000Z',
    plyCount: 40,
    reachedAtPly: 10,
    nextMoveUci: 'e2e4',
    sideToMove: 'w',
  };
}

function makeService(
  repo: ArchiveStatsRepository,
  metrics = new ArchiveMetricsService(),
) {
  const prisma = {} as never;
  const redis = new FakeRedis();
  return {
    svc: new ArchiveService(prisma, redis as never, metrics, repo),
    metrics,
    redis,
  };
}

describe('ArchiveService.getGamesByPosition — fail-closed guard (KS-1634)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Подавляем Logger.warn, чтобы тесты не шумели, и параллельно проверяем вызов.
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('Gherkin: items=[] и totalApprox>0 → totalApprox=null + метрика + warn', async () => {
    const repo = new ConfigurableRepo({ items: [], overflow: null }, 5);
    const { svc, metrics } = makeService(repo);

    const res = await svc.getGamesByPosition({ fen: START_FEN, bucket: 'master' });

    expect(res.items).toEqual([]);
    expect(res.totalApprox).toBeNull();
    expect(metrics.snapshot().listMismatchByBucket).toEqual({ master: 1, user: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toContain('archive.list.mismatch');
    expect(warnArg).toContain('bucket=master');
    expect(warnArg).toContain('totalApprox=5');
  });

  it('Gherkin: items=[1 партия], totalApprox=10 → totalApprox=10, метрика 0', async () => {
    const repo = new ConfigurableRepo(
      { items: [makeItem('00000000-0000-4000-a000-000000000010')], overflow: null },
      10,
    );
    const { svc, metrics } = makeService(repo);

    const res = await svc.getGamesByPosition({ fen: START_FEN, bucket: 'master' });

    expect(res.items).toHaveLength(1);
    expect(res.totalApprox).toBe(10);
    expect(metrics.snapshot().listMismatchByBucket).toEqual({ master: 0, user: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Gherkin: items=[] и totalApprox=0 → totalApprox=0, метрика 0 (условие >0 ложно)', async () => {
    const repo = new ConfigurableRepo({ items: [], overflow: null }, 0);
    const { svc, metrics } = makeService(repo);

    const res = await svc.getGamesByPosition({ fen: START_FEN, bucket: 'master' });

    expect(res.totalApprox).toBe(0);
    expect(metrics.snapshot().listMismatchByBucket).toEqual({ master: 0, user: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('bucket=user попадает в соответствующий счётчик метрики', async () => {
    const repo = new ConfigurableRepo({ items: [], overflow: null }, 3);
    const { svc, metrics } = makeService(repo);

    await svc.getGamesByPosition({ fen: START_FEN, bucket: 'user' });

    expect(metrics.snapshot().listMismatchByBucket).toEqual({ master: 0, user: 1 });
  });

  it('в Redis кешируется ответ с уже занулённым totalApprox (не "отравляет" кеш)', async () => {
    const repo = new ConfigurableRepo({ items: [], overflow: null }, 7);
    const { svc, metrics } = makeService(repo);

    const first = await svc.getGamesByPosition({ fen: START_FEN, bucket: 'master' });
    const second = await svc.getGamesByPosition({ fen: START_FEN, bucket: 'master' });

    expect(first.totalApprox).toBeNull();
    expect(second.totalApprox).toBeNull();
    // Второй запрос обслужен из кеша (repo не вызван повторно).
    expect(repo.gamesCalls).toBe(1);
    expect(repo.countCalls).toBe(1);
    // Guard сработал один раз — при первом запросе. Из кеша ответ уже
    // нормализован, повторно метрику не инкрементим.
    expect(metrics.snapshot().listMismatchByBucket.master).toBe(1);
  });
});
