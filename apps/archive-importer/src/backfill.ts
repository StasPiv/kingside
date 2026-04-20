/**
 * CLI-скрипт backfill: перебирает `archive_games` и заполняет
 * `archive_game_positions` существующими партиями (KS-1611 / ADR-014 §5).
 *
 * Поведение:
 *   - Читает archive_games keyset'ом по id (ASC) батчами `BATCH_SIZE`.
 *   - Из каждого батча отбрасывает game_id, уже присутствующие в
 *     `archive_game_positions` (SELECT DISTINCT … WHERE game_id = ANY(…)).
 *   - Парсит PGN через `parseGame`, подставляет Elo/результат/дату из
 *     самой записи archive_games (источник истины, а не PGN-заголовки).
 *   - Собирает строки через `buildPositionRowsForGame` и пишет батчем
 *     через `ArchivePositionWriter` (COPY → ON CONFLICT DO NOTHING).
 *   - Ошибка парсинга одной партии → stderr + continue.
 *   - Прогресс каждую итерацию: processed/total, rate, rows, ETA.
 *
 * Запуск:
 *   npm run archive:backfill --workspace=apps/archive-importer
 */

import { PrismaClient } from '@kingside/db';
import { parseGame, type ParsedGame } from './pgn-utils.js';
import {
  buildPositionRowsForGame,
  type PositionRow,
} from './position-row-builder.js';
import { ArchivePositionWriter } from './archive-position-writer.js';

const BATCH_SIZE = 2000;
const DEFAULT_BUCKET = 'master';
const PROGRESS_TAG = '[backfill]';

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

/**
 * ParsedGame, но поля metadata — из самой БД (archive_games). Builder
 * использует только `moves` / `whiteElo` / `blackElo` / `playedAt` /
 * `result`, но полную форму проще заполнить целиком.
 */
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

function logProgress(state: {
  processed: number;
  total: number;
  rowsWritten: number;
  skipped: number;
  parseFailed: number;
  startedAt: number;
}): void {
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  const rate = elapsedSec > 0 ? state.processed / elapsedSec : 0;
  const remaining = Math.max(0, state.total - state.processed);
  const etaSec = rate > 0 ? remaining / rate : Infinity;
  const pct = state.total > 0 ? ((state.processed / state.total) * 100).toFixed(1) : '—';

  console.log(
    `${PROGRESS_TAG} processed=${state.processed}/${state.total} (${pct}%) ` +
      `rate=${rate.toFixed(1)} g/s rows=${state.rowsWritten} ` +
      `skipped=${state.skipped} parseFailed=${state.parseFailed} ETA=${formatEta(etaSec)}`,
  );
}

async function fetchExistingGameIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.$queryRawUnsafe<Array<{ game_id: string }>>(
    `SELECT DISTINCT game_id FROM archive_game_positions WHERE game_id = ANY($1::uuid[])`,
    ids,
  );
  return new Set(rows.map((r) => r.game_id));
}

export async function runBackfill(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const writer = new ArchivePositionWriter(databaseUrl);

  const total = await prisma.archiveGame.count();
  console.log(`${PROGRESS_TAG} total archive_games=${total}; batch_size=${BATCH_SIZE}`);

  const state = {
    processed: 0,
    total,
    rowsWritten: 0,
    skipped: 0,
    parseFailed: 0,
    startedAt: Date.now(),
  };

  let cursor: string | null = null;
  try {
    while (true) {
      const games = (await prisma.archiveGame.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
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

      const existing = await fetchExistingGameIds(
        prisma,
        games.map((g) => g.id),
      );

      const rows: PositionRow[] = [];
      for (const g of games) {
        if (existing.has(g.id)) {
          state.skipped++;
          continue;
        }
        let parsed: ParsedGame | null = null;
        try {
          parsed = parseGame(g.pgn);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `${PROGRESS_TAG} game ${g.id}: parse threw: ${msg}`,
          );
        }
        if (!parsed) {
          state.parseFailed++;
          process.stderr.write(
            `${PROGRESS_TAG} game ${g.id}: PGN parse failed, skipping\n`,
          );
          continue;
        }
        const merged = mergeParsedWithDb(parsed, g);
        for (const row of buildPositionRowsForGame(g.id, merged, DEFAULT_BUCKET)) {
          rows.push(row);
        }
      }

      if (rows.length > 0) {
        try {
          await writer.write(rows, 'backfill');
          state.rowsWritten += rows.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${PROGRESS_TAG} writer.write failed: ${msg}`);
          // Падение одного батча не должно останавливать весь backfill,
          // но мы ещё не пометили эти game_id как обработанные. Двигаемся
          // дальше — повторный запуск обработает их заново (идемпотентно).
        }
      }

      state.processed += games.length;
      logProgress(state);
    }

    const elapsedSec = (Date.now() - state.startedAt) / 1000;
    console.log(
      `${PROGRESS_TAG} DONE processed=${state.processed} rows=${state.rowsWritten} ` +
        `skipped=${state.skipped} parseFailed=${state.parseFailed} ` +
        `elapsed=${formatEta(elapsedSec)}`,
    );
  } finally {
    await writer.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

// CLI entrypoint. `import.meta.url` trick — скрипт можно и `import`'ать
// в тестах без автозапуска.
// ESM entry check: true when script is launched directly (node / tsx).
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (isDirectRun) {
  runBackfill().catch((err) => {
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
