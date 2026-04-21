/**
 * CLI-скрипт backfill: перебирает `archive_games` и заполняет
 * `archive_game_positions` существующими партиями (KS-1611 / ADR-014 §5).
 *
 * Режимы (флаг `--mode=<default|extend>`, по умолчанию `default`):
 *
 *   default:
 *     - Читает `archive_games` keyset'ом по id (ASC) батчами `BATCH_SIZE`.
 *     - Отбрасывает game_id, уже присутствующие в `archive_game_positions`
 *       (SELECT DISTINCT … WHERE game_id = ANY(…)).
 *     - Парсит PGN через `parseGame`, собирает строки через
 *       `buildPositionRowsForGame` и пишет батчем через
 *       `ArchivePositionWriter` (COPY → ON CONFLICT DO NOTHING).
 *     - Годится для первичного наполнения индекса после включения фичи.
 *
 *   extend:
 *     - То же самое, НО без оптимизации `fetchExistingGameIds`: все партии
 *       обрабатываются, даже если у них уже есть строки в индексе.
 *     - Используется после подъёма `ARCHIVE_PLY_LIMIT` (KS-1632), чтобы
 *       дополнить старые партии (ply 0..24) строками ply 25..40.
 *     - Идемпотентность обеспечивает `ON CONFLICT DO NOTHING` по PK
 *       `(position_key, bucket, game_id)`: повторная заливка «старых» ply
 *       ничего не меняет, новые ply добавляются.
 *     - Метрика `newRowsInserted` считает реально вставленные строки
 *       (rowCount от INSERT), что != `rowsWritten` (= серилизовано в COPY).
 *
 * Общее поведение:
 *   - Ошибка парсинга одной партии → stderr + continue (не валит скрипт).
 *   - Прогресс каждую итерацию: processed/total, rate, rows, newRows, ETA,
 *     последний обработанный cursor (uuid) — для ручного resume.
 *   - Resume: `--resume-from=<uuid>` начинает с партии > указанного id.
 *
 * Запуск:
 *   npm run archive:backfill          --workspace=apps/archive-importer
 *   npm run archive:backfill:extend   --workspace=apps/archive-importer
 */

import { PrismaClient } from '@kingside/db';
import { parseGame, type ParsedGame } from './pgn-utils.js';
import {
  buildPositionRowsForGame,
  type PositionRow,
} from './position-row-builder.js';
import { ArchivePositionWriter } from './archive-position-writer.js';

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_BUCKET = 'master';
const PROGRESS_TAG = '[backfill]';

export type BackfillMode = 'default' | 'extend';

export interface BackfillOptions {
  mode: BackfillMode;
  batchSize: number;
  resumeFrom: string | null;
}

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
  newRowsInserted: number;
  skipped: number;
  parseFailed: number;
  startedAt: number;
  lastCursor: string | null;
  mode: BackfillMode;
}): void {
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  const rate = elapsedSec > 0 ? state.processed / elapsedSec : 0;
  const remaining = Math.max(0, state.total - state.processed);
  const etaSec = rate > 0 ? remaining / rate : Infinity;
  const pct = state.total > 0 ? ((state.processed / state.total) * 100).toFixed(1) : '—';

  console.log(
    `${PROGRESS_TAG} mode=${state.mode} processed=${state.processed}/${state.total} (${pct}%) ` +
      `rate=${rate.toFixed(1)} g/s rows=${state.rowsWritten} ` +
      `newRowsInserted=${state.newRowsInserted} ` +
      `skipped=${state.skipped} parseFailed=${state.parseFailed} ` +
      `cursor=${state.lastCursor ?? 'start'} ETA=${formatEta(etaSec)}`,
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

/**
 * Парсинг CLI-аргументов. Поддерживаемые флаги:
 *   --mode=default|extend                 (default: default)
 *   --batch-size=<N>                      (default: 2000)
 *   --resume-from=<uuid>                  (default: null — с начала)
 *
 * Экспортируется для юнит-тестов.
 */
export function parseArgs(argv: readonly string[]): BackfillOptions {
  let mode: BackfillMode = 'default';
  let batchSize = DEFAULT_BATCH_SIZE;
  let resumeFrom: string | null = null;

  for (const raw of argv) {
    if (raw === '--ignore-existing-game-ids') {
      mode = 'extend';
      continue;
    }
    const eq = raw.indexOf('=');
    if (!raw.startsWith('--') || eq < 0) continue;
    const name = raw.slice(2, eq);
    const value = raw.slice(eq + 1);
    switch (name) {
      case 'mode': {
        if (value !== 'default' && value !== 'extend') {
          throw new Error(`Unknown --mode=${value} (expected default|extend)`);
        }
        mode = value;
        break;
      }
      case 'batch-size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`Invalid --batch-size=${value}`);
        }
        batchSize = n;
        break;
      }
      case 'resume-from': {
        resumeFrom = value || null;
        break;
      }
      default:
        break;
    }
  }

  return { mode, batchSize, resumeFrom };
}

export async function runBackfill(options: BackfillOptions): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const writer = new ArchivePositionWriter(databaseUrl);

  const total = await prisma.archiveGame.count();
  console.log(
    `${PROGRESS_TAG} mode=${options.mode} total archive_games=${total}; ` +
      `batch_size=${options.batchSize} ` +
      `resume_from=${options.resumeFrom ?? 'start'}`,
  );

  const state = {
    processed: 0,
    total,
    rowsWritten: 0,
    newRowsInserted: 0,
    skipped: 0,
    parseFailed: 0,
    startedAt: Date.now(),
    lastCursor: null as string | null,
    mode: options.mode,
  };

  let cursor: string | null = options.resumeFrom;
  try {
    while (true) {
      const games = (await prisma.archiveGame.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: 'asc' },
        take: options.batchSize,
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
      state.lastCursor = cursor;

      // extend-mode пропускает оптимизацию: все партии перепроходятся, новые
      // ply 25..40 доливаются, старые ply 0..24 no-op по ON CONFLICT.
      const existing =
        options.mode === 'extend'
          ? new Set<string>()
          : await fetchExistingGameIds(
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
          const inserted = await writer.write(rows, `backfill:${options.mode}`);
          state.rowsWritten += rows.length;
          state.newRowsInserted += inserted;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${PROGRESS_TAG} writer.write failed: ${msg}`);
          // Падение одного батча не должно останавливать весь backfill,
          // но мы ещё не пометили эти game_id как обработанные. Двигаемся
          // дальше — повторный запуск обработает их заново (идемпотентно).
          // Cursor уже продвинут, так что resume возможен только вручную
          // с более раннего id, если это критично.
        }
      }

      state.processed += games.length;
      logProgress(state);
    }

    const elapsedSec = (Date.now() - state.startedAt) / 1000;
    console.log(
      `${PROGRESS_TAG} DONE mode=${state.mode} processed=${state.processed} ` +
        `rows=${state.rowsWritten} newRowsInserted=${state.newRowsInserted} ` +
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
  const options = parseArgs(process.argv.slice(2));
  runBackfill(options).catch((err) => {
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
