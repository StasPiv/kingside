/**
 * CLI-утилита полного пересчёта `position_stats` из `archive_games`
 * (KS-1621). Нужна для чинки раздутых счётчиков после ретраев
 * индексатора в старом коде.
 *
 * Поведение:
 *   1. TRUNCATE `position_stats`.
 *   2. Keyset-перебор `archive_games` по `id ASC` батчами.
 *   3. Парсинг PGN, подмена metadata из БД (как в backfill.ts), вызов
 *      `PositionIndexer.index(batch)` — делает UPSERT'ы по дельтам.
 *   4. После TRUNCATE инкременты равны исходным значениям → счётчики
 *      восстанавливаются ровно в «одноразовом» состоянии.
 *
 * Побочный эффект: `/api/archive/tree` на время rebuild'а может вернуть
 * меньше данных — эндпоинт остаётся доступен, но totalGames/moves
 * занижены до момента полного прогона. Для MVP приемлемо; для прода
 * лучше делать в staging-таблицу + SWAP (см. ADR-014, отложено).
 *
 * Запуск:
 *   ARCHIVE_DATABASE_URL=... npm run archive:rebuild-position-stats \
 *     --workspace=apps/archive-importer
 */

import { PrismaClient } from '@kingside/archive-db';
import Redis from 'ioredis';
import { parseGame, type ParsedGame } from './pgn-utils.js';
import { PositionIndexer } from './position-indexer.js';

const BATCH_SIZE = 2000;
const SOURCE_CODE = 'rebuild';
const PROGRESS_TAG = '[rebuild-position-stats]';
const ARCHIVE_IMPORTED_CHANNEL = 'archive:imported';

interface DbGameRow {
  id: string;
  pgn: string;
  whiteElo: number | null;
  blackElo: number | null;
  playedAt: Date | null;
  result: string | null;
  whiteTitle: string | null;
  blackTitle: string | null;
  whiteName: string | null;
  blackName: string | null;
  event: string | null;
  site: string | null;
  round: string | null;
  date: string | null;
  eco: string | null;
  opening: string | null;
  plyCount: number | null;
  finalFen: string | null;
}

function mergeParsedWithDb(parsed: ParsedGame, db: DbGameRow): ParsedGame {
  return {
    ...parsed,
    white: db.whiteName,
    black: db.blackName,
    whiteElo: db.whiteElo,
    blackElo: db.blackElo,
    whiteTitle: db.whiteTitle,
    blackTitle: db.blackTitle,
    event: db.event,
    site: db.site,
    round: db.round,
    date: db.date,
    playedAt: db.playedAt,
    result: db.result,
    eco: db.eco,
    opening: db.opening,
    plyCount: db.plyCount ?? parsed.moves.length,
    finalFen: db.finalFen ?? parsed.finalFen,
  };
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function rebuildPositionStats(): Promise<void> {
  const databaseUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!databaseUrl) throw new Error('ARCHIVE_DATABASE_URL is not set');

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const indexer = new PositionIndexer(prisma, SOURCE_CODE);

  try {
    // KS-1629: пересчёт только по классическим партиям (ADR-015 §3.5).
    // Не-классика сюда не попадает — см. `archive:cleanup-positions` и
    // `classify-existing` для зачистки старых данных.
    const total = await prisma.archiveGame.count({ where: { isClassical: true } });
    const totalAll = await prisma.archiveGame.count();
    console.log(
      `${PROGRESS_TAG} archive_games is_classical=${total} (of ${totalAll}); batch=${BATCH_SIZE}`,
    );

    console.log(`${PROGRESS_TAG} TRUNCATE position_stats ...`);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE position_stats');
    console.log(`${PROGRESS_TAG} position_stats truncated`);

    const startedAt = Date.now();
    let processed = 0;
    let parseFailed = 0;
    let cursor: string | null = null;

    while (true) {
      const games = (await prisma.archiveGame.findMany({
        where: {
          isClassical: true,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: {
          id: true,
          pgn: true,
          whiteElo: true,
          blackElo: true,
          playedAt: true,
          result: true,
          whiteTitle: true,
          blackTitle: true,
          whiteName: true,
          blackName: true,
          event: true,
          site: true,
          round: true,
          date: true,
          eco: true,
          opening: true,
          plyCount: true,
          finalFen: true,
        },
      })) as DbGameRow[];
      if (games.length === 0) break;

      cursor = games[games.length - 1].id;

      const batch: ParsedGame[] = [];
      for (const g of games) {
        let parsed: ParsedGame | null = null;
        try {
          parsed = parseGame(g.pgn);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${PROGRESS_TAG} game ${g.id}: parse threw: ${msg}`);
        }
        if (!parsed) {
          parseFailed++;
          process.stderr.write(
            `${PROGRESS_TAG} game ${g.id}: PGN parse failed, skipping\n`,
          );
          continue;
        }
        batch.push(mergeParsedWithDb(parsed, g));
      }

      if (batch.length > 0) {
        await indexer.index(batch);
      }

      processed += games.length;

      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = elapsed > 0 ? processed / elapsed : 0;
      const remaining = Math.max(0, total - processed);
      const eta = rate > 0 ? remaining / rate : Infinity;
      const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '—';
      console.log(
        `${PROGRESS_TAG} processed=${processed}/${total} (${pct}%) ` +
          `rate=${rate.toFixed(1)} g/s parseFailed=${parseFailed} ETA=${formatEta(eta)}`,
      );
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(
      `${PROGRESS_TAG} DONE processed=${processed} parseFailed=${parseFailed} elapsed=${formatEta(elapsed)}`,
    );

    // KS-1629/KS-1623: публикуем событие, чтобы API инвалидировал
    // `arch:tree:*` и `arch:games:*` в Redis. Подписчик —
    // `ArchiveService.invalidateArchiveCache()` (apps/api).
    await publishArchiveImported();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function publishArchiveImported(): Promise<void> {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT || '6380', 10);
  const password = process.env.REDIS_PASSWORD;

  const redis = new Redis({
    host,
    port,
    password,
    // Не висеть вечно, если Redis недоступен: быстрый fail после одной
    // попытки — rebuild свою работу уже сделал, инвалидация cache-only.
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  try {
    const n = await redis.publish(ARCHIVE_IMPORTED_CHANNEL, 'rebuild');
    console.log(
      `${PROGRESS_TAG} PUBLISH ${ARCHIVE_IMPORTED_CHANNEL} → ${n} subscriber(s)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${PROGRESS_TAG} redis publish failed (cache will TTL-expire): ${msg}`,
    );
  } finally {
    await redis.quit().catch(() => {});
  }
}

// ESM-safe entry: работает и как CLI, и как импорт.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] &&
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (isDirectRun) {
  rebuildPositionStats().catch((err) => {
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
