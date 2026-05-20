/**
 * KS-3148 / ADR-069 D1. Subcommand `backfill-puzzle-objective` —
 * одноразовый CLI для проставления `objective` (`convertAdvantage` /
 * `saveEquality`) у legacy PVE-пазлов, отобранных до KS-3145.
 *
 * После KS-3145 новые пазлы пишут `sourceMetadata.objective` сразу при
 * генерации, и тег добавляется в `themes`. Старые записи в БД его не
 * имеют — фильтр по тегу/жанру в каталоге их пропускает. CLI
 * вычисляет objective из тех же полей, что и api fallback в
 * `resolveSolutionMode`:
 *
 *   1) `sourceMetadata.wdlAfter` (Wdl POV solver) — основной путь
 *      через `determinePuzzleObjective(wdlAfter)`.
 *   2) `sourceMetadata.wdlAfterBlunder` (signed число) — fallback
 *      для совсем старых записей: `>= 0.5 ⇒ convertAdvantage`.
 *   3) Нет ни того, ни другого — пазл пропускается (skip:
 *      noWdlData), логируется в статистике.
 *
 * Пишет два поля одной UPDATE'ой:
 *   - `source_metadata` — merged JSON с добавленным `objective`;
 *   - `themes` — строка, в которую добавлен тег (если его ещё нет).
 *
 * Аргументы:
 *   --dry-run             только лог, без UPDATE
 *   --limit=N             ограничить N пазлами (для отладки/staging)
 *   --batch-size=N        размер пачки чтения (default 500)
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { determinePuzzleObjective, type PuzzleObjective } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dryRun: false, limit: null, batchSize: 500 };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'dry-run':
        opts.dryRun = v === undefined || v === '' || v === 'true';
        break;
      case 'limit':
        opts.limit = parseInt(v, 10);
        break;
      case 'batch-size':
        opts.batchSize = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return opts;
}

export interface BackfillStats {
  scanned: number;
  alreadyHadObjective: number;
  updated: number;
  /** разбивка `updated` по жанру для отчётности. */
  updatedConvertAdvantage: number;
  updatedSaveEquality: number;
  /** sourceMetadata не парсится как JSON или не object. */
  invalidMetadata: number;
  /** Нет ни `wdlAfter` ({w,d,l}), ни `wdlAfterBlunder` (number). */
  noWdlData: number;
  /** UPDATE упал по другой причине. */
  errors: number;
}

function emptyStats(): BackfillStats {
  return {
    scanned: 0,
    alreadyHadObjective: 0,
    updated: 0,
    updatedConvertAdvantage: 0,
    updatedSaveEquality: 0,
    invalidMetadata: 0,
    noWdlData: 0,
    errors: 0,
  };
}

interface WdlAfterRaw {
  w: number;
  d: number;
  l: number;
}

function parseWdlAfter(value: unknown): WdlAfterRaw | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const w = obj.w;
  const d = obj.d;
  const l = obj.l;
  if (typeof w !== 'number' || typeof d !== 'number' || typeof l !== 'number') {
    return null;
  }
  if (!Number.isFinite(w) || !Number.isFinite(d) || !Number.isFinite(l)) {
    return null;
  }
  if (w < 0 || d < 0 || l < 0) return null;
  return { w, d, l };
}

/**
 * Вычислить objective из metadata одним из двух путей (full Wdl или
 * legacy signed wdlAfterBlunder). null если данных не хватает.
 */
export function computeObjectiveFromMetadata(
  meta: Record<string, unknown>,
): PuzzleObjective | null {
  const wdlAfter = parseWdlAfter(meta.wdlAfter);
  if (wdlAfter) return determinePuzzleObjective(wdlAfter);
  const wdlAfterBlunder = meta.wdlAfterBlunder;
  if (typeof wdlAfterBlunder === 'number' && Number.isFinite(wdlAfterBlunder)) {
    return wdlAfterBlunder >= 0.5 ? 'convertAdvantage' : 'saveEquality';
  }
  return null;
}

/**
 * Применить objective к строке themes: добавить тег если его там ещё
 * нет (themes хранится как whitespace-separated). Возвращает новую
 * строку или исходную если изменений нет.
 */
export function addObjectiveTag(
  themes: string | null,
  objective: PuzzleObjective,
): string {
  const tokens = (themes ?? '').split(/\s+/).filter(Boolean);
  if (tokens.includes(objective)) return themes ?? '';
  tokens.push(objective);
  return Array.from(new Set(tokens)).sort().join(' ');
}

interface PuzzleRow {
  id: string;
  themes: string | null;
  source_metadata: string | null;
}

export async function runBackfillPuzzleObjective(
  app: INestApplicationContext,
  argv: string[],
): Promise<BackfillStats> {
  const logger = new Logger('cli:backfill-puzzle-objective');
  const opts = parseArgs(argv);
  const prisma = app.get(PrismaService);

  logger.log(
    `start dryRun=${opts.dryRun} limit=${opts.limit ?? 'none'} batchSize=${opts.batchSize}`,
  );

  // Берём только PVE-пазлы. Старые записи могут не иметь поля
  // `objective` в metadata вовсе, либо иметь его с null/legacy-значением —
  // ловим SQL'но через `->>` и фильтр на не-валидные ключи. На малых
  // выборках безопаснее читать всё и фильтровать в коде; на проде это
  // ~тысячи строк, окей.
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, themes, source_metadata
     FROM puzzles
     WHERE solution_mode = 'play-vs-engine'
     ORDER BY created_at ASC
     ${limitClause}`,
  )) as PuzzleRow[];

  const stats = emptyStats();
  for (const row of rows) {
    stats.scanned++;
    let meta: Record<string, unknown>;
    try {
      const parsed = row.source_metadata ? JSON.parse(row.source_metadata) : null;
      if (!parsed || typeof parsed !== 'object') {
        stats.invalidMetadata++;
        continue;
      }
      meta = parsed as Record<string, unknown>;
    } catch {
      stats.invalidMetadata++;
      continue;
    }

    const existing = meta.objective;
    if (existing === 'convertAdvantage' || existing === 'saveEquality') {
      stats.alreadyHadObjective++;
      continue;
    }

    const objective = computeObjectiveFromMetadata(meta);
    if (!objective) {
      stats.noWdlData++;
      continue;
    }

    const newThemes = addObjectiveTag(row.themes, objective);
    const newMeta = JSON.stringify({ ...meta, objective });

    if (opts.dryRun) {
      stats.updated++;
      if (objective === 'convertAdvantage') stats.updatedConvertAdvantage++;
      else stats.updatedSaveEquality++;
      continue;
    }

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE puzzles
         SET source_metadata = $1::jsonb,
             themes = $2
         WHERE id = $3::uuid`,
        newMeta,
        newThemes,
        row.id,
      );
      stats.updated++;
      if (objective === 'convertAdvantage') stats.updatedConvertAdvantage++;
      else stats.updatedSaveEquality++;
    } catch (e) {
      stats.errors++;
      logger.warn(
        `update failed for puzzle ${row.id}: ${(e as Error).message}`,
      );
    }
  }

  logger.log(
    `done dryRun=${opts.dryRun} scanned=${stats.scanned} ` +
      `alreadyHadObjective=${stats.alreadyHadObjective} ` +
      `updated=${stats.updated} ` +
      `(convert=${stats.updatedConvertAdvantage} save=${stats.updatedSaveEquality}) ` +
      `noWdlData=${stats.noWdlData} invalidMetadata=${stats.invalidMetadata} ` +
      `errors=${stats.errors}`,
  );
  process.stdout.write('=== KS-3148 BACKFILL STATS ===\n');
  process.stdout.write(JSON.stringify(stats, null, 2));
  process.stdout.write('\n=== END ===\n');
  return stats;
}
