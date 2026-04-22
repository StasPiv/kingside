/**
 * KS-1692 regression — `PostgresArchiveStatsRepository.getTree` возвращает
 * полный `totalGames` по позиции, а не сумму только топ-N next_move_uci.
 *
 * До фикса `getTree` считал `totalGames = rows.reduce(... + total)` по
 * результатам запроса с `ORDER BY total DESC LIMIT opts.limit`, а
 * `/games/by-position.totalApprox` использовал `countApprox` =
 * `SELECT SUM(total)` без LIMIT. Для позиций с числом уникальных
 * `next_move_uci` больше `opts.limit` (для стартовой позиции в TWIC —
 * существенно больше 12) это давало два разных числа на одну и ту же
 * позицию.
 *
 * Контракт `ArchiveTreeResponse.totalGames` требует полную сумму (см.
 * `packages/shared/src/types/archive.ts:55`). Спек ловит будущие регрессии:
 * если кто-то снова начнёт выводить `totalGames` из top-N rows, падает
 * проверка на равенство `getTree.totalGames` == `countApprox`.
 */
import type { PrismaService } from '../prisma/prisma.service';
import { PostgresArchiveStatsRepository } from './archive-stats.repository';
import { positionKey } from './position-key';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BUCKET = 'master' as const;

type StatsRow = {
  next_move_uci: string;
  white_wins: number;
  draws: number;
  black_wins: number;
  total: number;
  avg_elo: number | null;
  last_seen_at: Date | null;
};

/**
 * Генерирует 15 разных next_move_uci для стартовой позиции. Top-12 по total
 * суммируют 20019 (подстать prod-цифре `/tree.totalGames`), остальные 3 —
 * 11 партий (редкие первые ходы). Полная сумма = 20030 (подстать prod
 * `/games/by-position.totalApprox`).
 *
 * Хвост задан малыми `total` нарочно — именно такие хвосты и обрезает
 * `LIMIT 12`, формируя production-баг.
 */
function buildStatsRows(): StatsRow[] {
  const top12: Array<[string, number]> = [
    ['e2e4', 8000],
    ['d2d4', 5500],
    ['g1f3', 2600],
    ['c2c4', 2300],
    ['g2g3', 800],
    ['b2b3', 300],
    ['b1c3', 200],
    ['f2f4', 150],
    ['b2b4', 80],
    ['e2e3', 50],
    ['d2d3', 30],
    ['c2c3', 9],
  ];
  const tail3: Array<[string, number]> = [
    ['g1h3', 5],
    ['a2a3', 4],
    ['h2h3', 2],
  ];
  const all = [...top12, ...tail3];
  return all.map(([uci, total]) => ({
    next_move_uci: uci,
    white_wins: Math.floor(total * 0.4),
    draws: Math.floor(total * 0.3),
    black_wins: total - Math.floor(total * 0.4) - Math.floor(total * 0.3),
    total,
    avg_elo: 2400,
    last_seen_at: new Date('2026-04-22T00:00:00Z'),
  }));
}

/**
 * Fake PrismaService, выполняющий два известных SQL-паттерна:
 *   - `getTree` moves query — `ORDER BY total DESC LIMIT`
 *   - `countApprox` / `getTree` totals — `COALESCE(SUM(total)`
 * Любой другой SQL выкидывает — это защита от неожиданных запросов.
 */
function fakePrisma(rows: StatsRow[]): {
  prisma: PrismaService;
  /** Список SQL-строк, с которыми Prisma был вызван — для assert'ов. */
  sqls: string[];
} {
  const sqls: string[] = [];
  const $queryRawUnsafe = async <T>(sql: string, ..._params: unknown[]): Promise<T> => {
    sqls.push(sql);
    if (/COALESCE\(SUM\(total\)/.test(sql)) {
      const sum = rows.reduce((s, r) => s + r.total, 0);
      return [{ total: BigInt(sum) }] as unknown as T;
    }
    if (/ORDER BY total DESC\s+LIMIT/.test(sql)) {
      // Извлекаем лимит из parameters — он последний.
      const limit = _params[_params.length - 1] as number;
      return rows.slice(0, limit) as unknown as T;
    }
    throw new Error(`Unexpected SQL in fakePrisma: ${sql}`);
  };
  return {
    prisma: { $queryRawUnsafe } as unknown as PrismaService,
    sqls,
  };
}

describe('PostgresArchiveStatsRepository.getTree — KS-1692 regression', () => {
  it('totalGames равен полной сумме position_stats.total для позиции, а не сумме top-N rows', async () => {
    const rows = buildStatsRows();
    const { prisma, sqls } = fakePrisma(rows);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const response = await repo.getTree(positionKey(START_FEN), {
      fen: START_FEN,
      bucket: BUCKET,
      limit: 12,
    });

    const fullSum = rows.reduce((s, r) => s + r.total, 0);
    const top12Sum = rows
      .slice(0, 12)
      .reduce((s, r) => s + r.total, 0);

    // Пред-условие fixture'а: top-12 ≠ полная сумма. Если это не так, тест
    // потерял смысл и нужно подправить buildStatsRows.
    expect(fullSum).toBeGreaterThan(top12Sum);

    expect(response.totalGames).toBe(fullSum);
    expect(response.totalGames).not.toBe(top12Sum);

    // moves[] ограничен top-N — это поведение оставляем как есть.
    expect(response.moves).toHaveLength(12);
    expect(response.moves[0].uci).toBe('e2e4');

    // Проверяем, что был сделан отдельный SUM(total)-запрос без LIMIT —
    // если кто-то вернёт старую реализацию, этот assert тоже упадёт.
    expect(sqls.some((s) => /COALESCE\(SUM\(total\)/.test(s))).toBe(true);
  });

  it('getTree.totalGames == countApprox для одной и той же позиции/bucket (инвариант KS-1692)', async () => {
    const rows = buildStatsRows();
    const { prisma } = fakePrisma(rows);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const posKey = positionKey(START_FEN);
    const [tree, approx] = await Promise.all([
      repo.getTree(posKey, { fen: START_FEN, bucket: BUCKET, limit: 12 }),
      repo.countApprox(posKey, BUCKET),
    ]);

    expect(tree.totalGames).toBe(approx);
  });

  it('при числе next_move_uci ≤ limit totalGames совпадает с суммой moves (нет регрессии на маленьких позициях)', async () => {
    // Только 3 разных хода — все влезают в limit=12. Полная сумма ==
    // сумма moves[]. Тест охраняет от «переусердствовавшего» фикса,
    // который мог бы возвращать 0 при малом числе строк.
    const smallRows: StatsRow[] = [
      { next_move_uci: 'e2e4', white_wins: 1, draws: 0, black_wins: 0, total: 2, avg_elo: 2500, last_seen_at: null },
      { next_move_uci: 'd2d4', white_wins: 0, draws: 1, black_wins: 0, total: 1, avg_elo: 2400, last_seen_at: null },
      { next_move_uci: 'c2c4', white_wins: 0, draws: 0, black_wins: 1, total: 1, avg_elo: 2350, last_seen_at: null },
    ];
    const { prisma } = fakePrisma(smallRows);
    const repo = new PostgresArchiveStatsRepository(prisma);

    const response = await repo.getTree(positionKey(START_FEN), {
      fen: START_FEN,
      bucket: BUCKET,
      limit: 12,
    });

    expect(response.totalGames).toBe(4);
    expect(response.moves).toHaveLength(3);
  });
});
