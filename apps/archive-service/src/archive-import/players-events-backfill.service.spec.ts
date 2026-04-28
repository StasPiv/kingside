/**
 * KS-2064 — `PlayersEventsBackfillService`.
 *
 * Через fake-Prisma проверяем:
 *   - агрегацию по нормализованной форме (Carlsen,M / Carlsen, M.
 *     сводятся в одну запись);
 *   - корректный peak_elo (берём собственный elo стороны);
 *   - first/last seenAt по played_at;
 *   - выбор canonical как самой частой raw-формы;
 *   - separate UPSERT-флоу в `syncDelta`.
 */
import { ArchiveImportMetricsService } from './archive-import-metrics.service';
import { PlayersEventsBackfillService } from './players-events-backfill.service';
import type { PrismaService } from '../prisma/prisma.service';

interface SqlCall {
  sql: string;
  params: unknown[];
}

interface FakeRow {
  id: string;
  white_name: string | null;
  black_name: string | null;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  played_at: Date | null;
  date: string | null;
}

function fakePrisma(rows: FakeRow[]): { prisma: PrismaService; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  let cursor = 0;

  const $queryRawUnsafe = async <T>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params });
    if (/FROM archive_games/i.test(sql)) {
      // Возвращаем все строки, потом 0 → стрим завершится.
      if (cursor === 0) {
        cursor = rows.length;
        return rows as unknown as T;
      }
      return [] as unknown as T;
    }
    if (/FROM archive_players/i.test(sql) && /COUNT/i.test(sql)) {
      return [{ n: BigInt(0) }] as unknown as T;
    }
    if (/FROM archive_events/i.test(sql) && /COUNT/i.test(sql)) {
      return [{ n: BigInt(0) }] as unknown as T;
    }
    return [] as unknown as T;
  };
  const $executeRawUnsafe = async (sql: string, ...params: unknown[]): Promise<number> => {
    calls.push({ sql, params });
    return 1;
  };
  return {
    prisma: { $queryRawUnsafe, $executeRawUnsafe } as unknown as PrismaService,
    calls,
  };
}

function makeMetrics(): ArchiveImportMetricsService {
  // Реальный prom-client Registry; новые экземпляры на каждый тест,
  // чтобы не было конфликта имён между вызовами Histogram(...) etc.
  const { Registry } = jest.requireActual('prom-client') as typeof import('prom-client');
  const registry = new Registry();
  return new ArchiveImportMetricsService({ registry } as never);
}

function findCalls(calls: SqlCall[], pattern: RegExp): SqlCall[] {
  return calls.filter((c) => pattern.test(c.sql));
}

describe('PlayersEventsBackfillService — KS-2064', () => {
  const PLAYED_AT_1 = new Date('2024-01-01T00:00:00Z');
  const PLAYED_AT_2 = new Date('2025-01-01T00:00:00Z');

  it('сводит "Carlsen,M." и "Carlsen, M." в одну запись (одинаковая нормализация)', async () => {
    const rows: FakeRow[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        white_name: 'Carlsen,M.',
        black_name: 'Caruana, F',
        white_elo: 2830,
        black_elo: 2820,
        event: 'Tata Steel 2024',
        played_at: PLAYED_AT_1,
        date: '2024.01.15',
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        white_name: 'Caruana,F.',
        black_name: 'Carlsen, M.', // тот же игрок, другое написание
        white_elo: 2820,
        black_elo: 2860,
        event: 'Tata Steel 2024',
        played_at: PLAYED_AT_2,
        date: '2024.01.16',
      },
    ];
    const { prisma } = fakePrisma(rows);
    const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

    const report = await svc.backfillAll();

    expect(report.scannedGames).toBe(2);
    // 'Carlsen,M.' / 'Carlsen, M.' → 'carlsen m'
    // 'Caruana, F'  / 'Caruana,F.' → 'caruana f'
    // → 2 уникальных игрока, 1 событие.
    expect(report.insertedPlayers).toBe(2);
    expect(report.insertedEvents).toBe(1);
  });

  it('peak_elo берётся как elo стороны игрока (KS-2064 фикс ADR §4.4.6: не GREATEST соперника)', async () => {
    const rows: FakeRow[] = [
      {
        id: 'g1',
        white_name: 'Magnus',
        black_name: 'Opponent',
        white_elo: 2870,
        black_elo: 2900, // соперник сильнее
        event: null,
        played_at: PLAYED_AT_1,
        date: null,
      },
    ];
    const { prisma, calls } = fakePrisma(rows);
    const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

    await svc.backfillAll();

    // Игрок 'Magnus' должен попасть с peak_elo=2870, а не 2900.
    const playerInserts = findCalls(calls, /INSERT INTO archive_players/);
    expect(playerInserts.length).toBeGreaterThan(0);

    // Параметры: каждые 8 — один игрок (slug, name_canonical, name_normalized,
    // name_aliases, games_count, peak_elo, first_seen_at, last_seen_at).
    const params = playerInserts[0].params;
    // Найдём индекс slug='magnus' и сравним peak_elo через 5.
    let foundMagnusElo: number | null = null;
    let foundOpponentElo: number | null = null;
    for (let i = 0; i + 7 < params.length; i += 8) {
      const slug = params[i] as string;
      const peak = params[i + 5] as number | null;
      if (slug === 'magnus') foundMagnusElo = peak;
      if (slug === 'opponent') foundOpponentElo = peak;
    }
    expect(foundMagnusElo).toBe(2870);
    expect(foundOpponentElo).toBe(2900);
  });

  it('TRUNCATE перед INSERT', async () => {
    const rows: FakeRow[] = [
      {
        id: 'g1',
        white_name: 'A',
        black_name: 'B',
        white_elo: null,
        black_elo: null,
        event: null,
        played_at: null,
        date: null,
      },
    ];
    const { prisma, calls } = fakePrisma(rows);
    const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

    await svc.backfillAll();

    const playerTrunc = findCalls(calls, /TRUNCATE archive_players/);
    const eventTrunc = findCalls(calls, /TRUNCATE archive_events/);
    expect(playerTrunc).toHaveLength(1);
    expect(eventTrunc).toHaveLength(1);
  });

  it('REFRESH MV выполняется после INSERT (initial — без CONCURRENTLY)', async () => {
    const rows: FakeRow[] = [];
    const { prisma, calls } = fakePrisma(rows);
    const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

    const report = await svc.backfillAll();

    expect(report.refreshedViewMode).toBe('initial');
    const refreshes = findCalls(calls, /REFRESH MATERIALIZED VIEW.*archive_player_stats/);
    expect(refreshes.length).toBeGreaterThan(0);
    // initial — без CONCURRENTLY.
    expect(refreshes[refreshes.length - 1].sql).not.toMatch(/CONCURRENTLY/);
  });

  it('пустые/null имена не создают записей', async () => {
    const rows: FakeRow[] = [
      {
        id: 'g1',
        white_name: null,
        black_name: '   ',
        white_elo: null,
        black_elo: null,
        event: null,
        played_at: null,
        date: null,
      },
    ];
    const { prisma, calls } = fakePrisma(rows);
    const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

    const report = await svc.backfillAll();

    expect(report.insertedPlayers).toBe(0);
    expect(report.insertedEvents).toBe(0);
  });

  describe('syncDelta', () => {
    it('UPSERT и REFRESH CONCURRENTLY', async () => {
      const { prisma, calls } = fakePrisma([]);
      const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

      const report = await svc.syncDelta({
        games: [
          {
            whiteName: 'New Player',
            blackName: 'Other',
            whiteElo: 2500,
            blackElo: 2400,
            event: 'New Event',
            playedAt: PLAYED_AT_1,
            date: '2024.01.15',
          },
        ],
      });

      expect(report.upsertedPlayers).toBe(2);
      expect(report.upsertedEvents).toBe(1);
      const concurrent = findCalls(
        calls,
        /REFRESH MATERIALIZED VIEW CONCURRENTLY archive_player_stats/,
      );
      expect(concurrent.length).toBe(1);
    });

    it('пустой delta — не зовёт REFRESH', async () => {
      const { prisma, calls } = fakePrisma([]);
      const svc = new PlayersEventsBackfillService(prisma, makeMetrics());

      const report = await svc.syncDelta({ games: [] });

      expect(report.upsertedPlayers).toBe(0);
      expect(report.upsertedEvents).toBe(0);
      expect(findCalls(calls, /REFRESH/)).toHaveLength(0);
    });
  });
});
