/**
 * Ядро CLI-утилиты полного пересчёта `position_stats` из `archive_games`
 * (KS-1621). Нужна для чинки раздутых счётчиков после ретраев
 * индексатора в старом коде.
 *
 * CLI-shim — в `apps/archive-service/src/cli/rebuild-position-stats.ts`.
 */

import type { PrismaClient } from '@kingside/archive-db';
import Redis from 'ioredis';
import { parseGame, type ParsedGame } from './pgn-utils';
import {
  PositionIndexerService,
  type PositionIndexerPrisma,
} from './position-indexer.service';

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

export async function rebuildPositionStats(
  prisma: PrismaClient,
  indexer: PositionIndexerService,
): Promise<void> {
  // KS-1629: пересчёт только по классическим партиям (ADR-015 §3.5).
  const total = await prisma.archiveGame.count({ where: { isClassical: true } });
  const totalAll = await prisma.archiveGame.count();
  // eslint-disable-next-line no-console
  console.log(
    `${PROGRESS_TAG} archive_games is_classical=${total} (of ${totalAll}); batch=${BATCH_SIZE}`,
  );

  // eslint-disable-next-line no-console
  console.log(`${PROGRESS_TAG} TRUNCATE position_stats ...`);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE position_stats');
  // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
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
      await indexer.indexWithPrisma(
        prisma as unknown as PositionIndexerPrisma,
        batch,
        SOURCE_CODE,
      );
    }

    processed += games.length;

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? processed / elapsed : 0;
    const remaining = Math.max(0, total - processed);
    const eta = rate > 0 ? remaining / rate : Infinity;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '—';
    // eslint-disable-next-line no-console
    console.log(
      `${PROGRESS_TAG} processed=${processed}/${total} (${pct}%) ` +
        `rate=${rate.toFixed(1)} g/s parseFailed=${parseFailed} ETA=${formatEta(eta)}`,
    );
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  // eslint-disable-next-line no-console
  console.log(
    `${PROGRESS_TAG} DONE processed=${processed} parseFailed=${parseFailed} elapsed=${formatEta(elapsed)}`,
  );

  await publishArchiveImported();
}

async function publishArchiveImported(): Promise<void> {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT || '6380', 10);
  const password = process.env.REDIS_PASSWORD;

  const redis = new Redis({
    host,
    port,
    password,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  try {
    const n = await redis.publish(ARCHIVE_IMPORTED_CHANNEL, 'rebuild');
    // eslint-disable-next-line no-console
    console.log(
      `${PROGRESS_TAG} PUBLISH ${ARCHIVE_IMPORTED_CHANNEL} → ${n} subscriber(s)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `${PROGRESS_TAG} redis publish failed (cache will TTL-expire): ${msg}`,
    );
  } finally {
    await redis.quit().catch(() => {});
  }
}
