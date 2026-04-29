/**
 * KS-2120 — keyset cursor для `getGamesByPosition` при `sort=topElo`.
 *
 * Регрессия: до фикса cursor собирался как
 *   `(p.avg_elo < $E OR (p.avg_elo = $E AND p.game_id < $G))`,
 * планировщик Postgres не распознавал OR как продолжение btree-traversal'а
 * по DESC-индексу `archive_game_positions_top_elo` и сводил его к
 * `Filter` поверх Index Scan. На стартовой позиции (~117K строк под
 * `position_key`) это давало 2.17 сек cold cache (EXPLAIN ANALYZE,
 * KS-2121). После фикса cursor — ROW-comparison
 *   `(p.avg_elo, p.game_id) < ($E, $G::uuid)`,
 * btree-планировщик использует её как Index Cond.
 */
import type { PrismaService } from '../prisma/prisma.service';
import {
  PostgresArchiveStatsRepository,
  GamesByPositionOpts,
} from './archive-stats.repository';
import type { TopEloCursor, RecentCursor } from './cursor-codec';

interface CapturedCall {
  sql: string;
  params: unknown[];
}

function fakePrisma(): { prisma: PrismaService; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const $queryRawUnsafe = async <T>(sql: string, ...params: unknown[]): Promise<T> => {
    calls.push({ sql, params });
    return [] as unknown as T;
  };
  return {
    prisma: { $queryRawUnsafe } as unknown as PrismaService,
    calls,
  };
}

const POS_KEY = Buffer.from('bed6f817f1cd7bddd820b5a588e7cf9b', 'hex');

function defaults(): GamesByPositionOpts {
  return {
    bucket: 'master',
    sort: 'topElo',
    cursor: null,
    limit: 20,
  };
}

describe('PostgresArchiveStatsRepository.getGamesByPosition — keyset cursor', () => {
  describe('sort=topElo', () => {
    it('без cursor → нет keyset-условия в WHERE', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);

      await repo.getGamesByPosition(POS_KEY, defaults());

      expect(calls).toHaveLength(1);
      const { sql } = calls[0]!;
      expect(sql).not.toMatch(/avg_elo\s*<|avg_elo\s*=/);
    });

    it('cursor.e=число → ROW-comparison `(p.avg_elo, p.game_id) < ($n, $m::uuid)` (KS-2120)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      const cur: TopEloCursor = {
        e: 2700,
        g: 'd13fa304-d429-4e9d-9422-c20f0df75329',
      };

      await repo.getGamesByPosition(POS_KEY, { ...defaults(), cursor: cur });

      expect(calls).toHaveLength(1);
      const { sql, params } = calls[0]!;
      // ROW-comparison — btree-planner понимает её как Index Cond.
      expect(sql).toMatch(/\(p\.avg_elo,\s*p\.game_id\)\s*<\s*\(\$\d+,\s*\$\d+::uuid\)/);
      // Старый OR-вариант больше не должен генерироваться.
      expect(sql).not.toMatch(/p\.avg_elo\s*<\s*\$\d+\s+OR\s+\(p\.avg_elo\s*=/);
      // Параметры курсора прокинуты единичными значениями (без дублирования
      // avg_elo, как было в OR-варианте).
      expect(params).toContain(2700);
      expect(params).toContain('d13fa304-d429-4e9d-9422-c20f0df75329');
      const eloOccurrences = params.filter((p) => p === 2700).length;
      expect(eloOccurrences).toBe(1);
    });

    it('KS-2130: cursor.e=null → блок пуст (FALSE), потому что WHERE avg_elo IS NOT NULL', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      const cur: TopEloCursor = {
        e: null,
        g: 'd13fa304-d429-4e9d-9422-c20f0df75329',
      };

      await repo.getGamesByPosition(POS_KEY, { ...defaults(), cursor: cur });

      const { sql } = calls[0]!;
      // Со стороны прежнего клиента (cursor `e=null`) блок NULL'ов теперь
      // пуст — отдаём заведомо ложное условие.
      expect(sql).toMatch(/\bFALSE\b/);
      // Ни ROW-comparison, ни прежний `IS NULL AND game_id <` не уместны.
      expect(sql).not.toMatch(/\(p\.avg_elo,\s*p\.game_id\)\s*</);
      expect(sql).not.toMatch(/p\.avg_elo IS NULL\s+AND\s+p\.game_id\s*</);
    });

    it('KS-2130: ORDER BY без NULLS LAST + WHERE avg_elo IS NOT NULL', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);

      await repo.getGamesByPosition(POS_KEY, defaults());

      const { sql } = calls[0]!;
      // KS-2130: ORDER BY совпадает с порядком индекса
      // archive_game_positions_top_elo (без NULLS LAST), позволяет
      // использовать btree для упорядоченного чтения.
      expect(sql).toContain('ORDER BY p.avg_elo DESC, p.game_id DESC');
      expect(sql).not.toContain('NULLS LAST');
      // Партии без рейтинга отсекаются — у них нет avg_elo для top.
      expect(sql).toContain('p.avg_elo IS NOT NULL');
    });
  });

  describe('sort=recent (контрольный кейс — поведение не менялось)', () => {
    it('cursor.t=Date → старый OR-вариант (recent НЕ переписан в KS-2120)', async () => {
      const { prisma, calls } = fakePrisma();
      const repo = new PostgresArchiveStatsRepository(prisma);
      const cur: RecentCursor = {
        t: new Date('2026-04-01T00:00:00Z').toISOString(),
        g: 'd13fa304-d429-4e9d-9422-c20f0df75329',
      };

      await repo.getGamesByPosition(POS_KEY, {
        ...defaults(),
        sort: 'recent',
        cursor: cur,
      });

      const { sql } = calls[0]!;
      // Recent сейчас не идёт по btree-индексу (`archive_game_positions_recent`
      // удалён в этой же задаче), поэтому переход на ROW-comparison не даёт
      // выигрыша. Если в будущем понадобится — отдельный тикет с разбором
      // плана.
      expect(sql).toMatch(/p\.played_at\s*<\s*\$\d+\s+OR\s+\(p\.played_at\s*=/);
    });
  });
});
