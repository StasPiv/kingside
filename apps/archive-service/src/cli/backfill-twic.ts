/**
 * CLI shim: `node dist/cli/backfill-twic.js` (KS-1718).
 *
 * Ad-hoc backfill конкретного TWIC-выпуска с ЯВНЫМ контрактом, не
 * конфликтующим с штатным importer-once (scheduler'ом).
 *
 * Зачем отдельный CLI (а не расширение `import-twic-issue.ts`):
 *   - Явное имя делает назначение очевидным в ECS task-def / run-task
 *     команде: `backfill-twic` не спутать с `importer-once` (scheduler).
 *   - Контракт ввода — ENV + флаг. ENV-переменные надёжнее в ECS
 *     `run-task --overrides`, т.к. аргумент `command` при override'е
 *     может быть склеен с entrypoint task-def'а и проигнорирован
 *     (именно это произошло у devops в KS-1718 preamble: override
 *     `command=["node","dist/cli/import-twic-issue.js","1638"]` задан
 *     на task-def с entrypoint `node dist/importer-once.js`, и процесс
 *     ушёл штатным путём cursor+1, игнорируя аргумент).
 *   - Per-issue Redis-lock — `archive:import:lock:twic:backfill:<N>` —
 *     отдельный от scheduler-lock'а `archive:import:lock:twic`.
 *     Scheduler и backfill могут работать параллельно; content_hash
 *     UNIQUE обеспечивает целостность на уровне БД.
 *
 * Контракт:
 *   - Номер выпуска: `--issue <N>` (приоритет) или env `TWIC_ISSUE=<N>`.
 *   - Повторный backfill: по умолчанию — skip с сообщением и exit 0, если
 *     в `archive_imports` уже есть запись `file_name LIKE 'twicN%.pgn',
 *     status='ok'` для того же `source_id`. Флаг `--force` (или env
 *     `TWIC_BACKFILL_FORCE=1`) переимпортирует: runAdHoc отработает,
 *     но `filterAlreadyImported` отбросит все партии с уже
 *     существующим content_hash — `gamesAdded=0, gamesSkipped=<всё>`.
 *     Дублей игр не появится, но запись в `archive_imports` создастся
 *     новая — полезно для аудита «пытались переимпортировать X, в БД
 *     уже всё, ничего не изменилось».
 *   - НЕ двигает `archive_sources.cursor` (делегируется в `runAdHoc`,
 *     который внутри TwicImporter вызывает runForIssue с
 *     `updateSourceCursor: false`).
 *
 * Exit codes:
 *   - 0   — импорт успешен (ok/partial), либо skip-already-imported
 *           без `--force`;
 *   - 1   — parseArgs / bootstrap / неожиданный throw;
 *   - 2   — импорт отработал, но `status='failed'` (404/5xx/unzip/DB);
 *   - 3   — lock занят другим backfill того же выпуска (повтор позже).
 */

import 'reflect-metadata';
import type Redis from 'ioredis';
import type { PrismaClient } from '@kingside/archive-db';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ArchivePositionWriterService } from '../archive-import/archive-position-writer.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { ArchiveImportMetricsService } from '../archive-import/archive-import-metrics.service';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from '../archive-import/sources/twic.importer';
import { acquireLock } from '../archive-import/archive-import-lock';

const PROGRESS_TAG = '[cli:backfill-twic]';
const ARCHIVE_IMPORTED_CHANNEL = 'archive:imported';

/** Per-issue lock — scheduler-lock `archive:import:lock:twic` НЕ трогаем. */
export function lockKeyFor(issue: number): string {
  return `archive:import:lock:twic:backfill:${issue}`;
}

export const EXIT_OK = 0;
export const EXIT_BOOTSTRAP = 1;
export const EXIT_IMPORT_FAILED = 2;
export const EXIT_LOCK_HELD = 3;

export interface BackfillTwicArgs {
  issue: number;
  force: boolean;
}

/**
 * Парсит argv + env → `{ issue, force }`.
 *
 * Приоритет: `--issue <N>` > `TWIC_ISSUE` env. То же для force:
 * `--force` > `TWIC_BACKFILL_FORCE=1|true|yes`.
 *
 * Бросает с usage-текстом, если ни `--issue`, ни `TWIC_ISSUE` не заданы,
 * или значение не positive integer.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BackfillTwicArgs {
  let flagIssue: string | undefined;
  let flagForce = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--force') {
      flagForce = true;
    } else if (token === '--issue') {
      flagIssue = argv[i + 1];
      i++;
    } else if (token.startsWith('--issue=')) {
      flagIssue = token.slice('--issue='.length);
    }
  }

  const rawIssue = flagIssue ?? env.TWIC_ISSUE;
  if (!rawIssue) {
    throw new Error(
      'Usage: backfill-twic --issue <N> [--force]\n' +
        '       or env TWIC_ISSUE=<N> [TWIC_BACKFILL_FORCE=1]',
    );
  }
  const trimmed = String(rawIssue).trim();
  const issue = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(issue) || issue <= 0 || String(issue) !== trimmed) {
    throw new Error(
      `Invalid issue number: "${rawIssue}" (expected positive integer)`,
    );
  }

  const envForceRaw = env.TWIC_BACKFILL_FORCE ?? '';
  const envForce = /^(1|true|yes)$/i.test(envForceRaw.trim());
  return { issue, force: flagForce || envForce };
}

export interface BackfillTwicDeps {
  prisma: Pick<PrismaClient, 'archiveSource' | 'archiveImport'>;
  // KS-1898: добавлены `eval` (Lua release/extend) и `get` (для symmetry
  // с lock-helper'ом). `del` оставлен — публичная поверхность ioredis,
  // не убираем.
  redis: Pick<Redis, 'set' | 'del' | 'publish' | 'get' | 'eval'>;
  makeImporter: (source: ArchiveSourceRow) => Pick<TwicImporter, 'runAdHoc'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** KS-1898: подмена heartbeat-таймеров (только для тестов). */
  lockHeartbeatOpts?: {
    setInterval?: (cb: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
  };
}

export interface BackfillTwicOutcome {
  /** `null`, если skip-already-imported без `--force`. */
  result: ImportResult | null;
  /** true, если выпуск уже был импортирован и force=false — runAdHoc не вызывался. */
  skippedAlreadyImported: boolean;
  /** true, если lock занят другим процессом (runAdHoc не вызывался). */
  lockHeld: boolean;
}

/**
 * Ядро CLI: резолвит source, проверяет «уже импортировано», берёт
 * per-issue Redis-lock, вызывает `TwicImporter.runAdHoc`, PUBLISH'ит
 * `archive:imported` при `gamesAdded > 0`, отпускает lock в finally.
 */
export async function runBackfillTwic(
  deps: BackfillTwicDeps,
  args: BackfillTwicArgs,
): Promise<BackfillTwicOutcome> {
  const { prisma, redis, makeImporter, logger } = deps;

  const source = await prisma.archiveSource.findFirst({
    where: { code: 'twic' },
  });
  if (!source) {
    throw new Error('archive_sources row with code="twic" not found');
  }

  // Idempotent-check: если выпуск уже есть в archive_imports со status=ok,
  // по умолчанию не дёргаем TWIC повторно (не жжём их серверу 10-20 МБ
  // zip'а и не тратим ECS-task на известный duplicate). С `--force`
  // оператор явно говорит «перепроверить», runAdHoc отработает
  // идемпотентно (filterAlreadyImported отбросит всё).
  if (!args.force) {
    const existing = await prisma.archiveImport.findFirst({
      where: {
        sourceId: source.id,
        status: 'ok',
        fileName: { startsWith: `twic${args.issue}` },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, fileName: true, gamesAdded: true, startedAt: true },
    });
    if (existing) {
      logger.log(
        `${PROGRESS_TAG} issue=${args.issue} already imported ` +
          `(import_id=${existing.id}, file=${existing.fileName}, ` +
          `games_added=${existing.gamesAdded}, started=${existing.startedAt?.toISOString() ?? '?'}) ` +
          `— skipping. Pass --force to re-run.`,
      );
      return {
        result: null,
        skippedAlreadyImported: true,
        lockHeld: false,
      };
    }
  }

  const lockKey = lockKeyFor(args.issue);
  // KS-1898: короткий TTL (60s default) + heartbeat (30s) + UUID-токен
  // в value + Lua release. После SIGKILL ECS-таска ключ отпускается за
  // ≤60 сек, а не висит до старого 30-минутного TTL.
  const lock = await acquireLock({
    redis,
    key: lockKey,
    role: 'backfill',
    issue: args.issue,
    logger,
    setInterval: deps.lockHeartbeatOpts?.setInterval,
    clearInterval: deps.lockHeartbeatOpts?.clearInterval,
  });
  if (!lock) {
    logger.warn(
      `${PROGRESS_TAG} lock "${lockKey}" held — another backfill for issue=${args.issue} is in-flight; ` +
        `try again in a minute`,
    );
    return {
      result: null,
      skippedAlreadyImported: false,
      lockHeld: true,
    };
  }

  try {
    const importer = makeImporter({
      id: source.id,
      code: source.code,
      cursor: source.cursor ?? null,
    });
    logger.log(
      `${PROGRESS_TAG} issue=${args.issue} force=${args.force} ` +
        `source.cursor=${source.cursor ?? 'null'} lock=${lockKey} — starting backfill ` +
        `(cursor will NOT change)`,
    );
    const result = await importer.runAdHoc(args.issue);
    logger.log(
      `${PROGRESS_TAG} issue=${args.issue} status=${result.status} ` +
        `parsed=${result.gamesParsed} added=${result.gamesAdded} skipped=${result.gamesSkipped}` +
        (result.error ? ` error="${result.error}"` : ''),
    );

    if (result.gamesAdded > 0) {
      try {
        const n = await redis.publish(
          ARCHIVE_IMPORTED_CHANNEL,
          `twic:${args.issue}`,
        );
        logger.log(
          `${PROGRESS_TAG} PUBLISH ${ARCHIVE_IMPORTED_CHANNEL} → ${n} subscriber(s)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Кеш всё равно инвалидируется по TTL — не пробрасываем.
        logger.warn(
          `${PROGRESS_TAG} redis publish failed (cache will TTL-expire): ${msg}`,
        );
      }
    }

    return {
      result,
      skippedAlreadyImported: false,
      lockHeld: false,
    };
  } finally {
    // KS-1898: token-safe release через Lua. Heartbeat останавливается
    // внутри release(). Если наш TTL истёк и ключ перехвачен — Lua
    // вернёт 0, DEL не сделает.
    await lock.release().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `${PROGRESS_TAG} failed to release ${lockKey} (relying on TTL=${lock.ttlMs}ms): ${msg}`,
      );
    });
  }
}

async function main(): Promise<void> {
  let args: BackfillTwicArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} ${(err as Error).message}`);
    process.exit(EXIT_BOOTSTRAP);
    return;
  }

  // KS-1722: bootstrap через `AdHocCliModule` — без `ScheduleModule` и без
  // `ArchiveImportService.onModuleInit`-immediate tick'а. См. KS-1720 для
  // первичного фикса этой ловушки.
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  const logger = new Logger('cli:backfill-twic');
  let exitCode: number = EXIT_OK;

  try {
    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    const writer = app.get(ArchivePositionWriterService);
    const indexer = app.get(PositionIndexerService);
    const metrics = app.get(ArchiveImportMetricsService);

    const outcome = await runBackfillTwic(
      {
        prisma,
        redis,
        makeImporter: (source) =>
          new TwicImporter(prisma, source, writer, indexer, metrics),
        logger,
      },
      args,
    );

    if (outcome.lockHeld) {
      exitCode = EXIT_LOCK_HELD;
    } else if (outcome.skippedAlreadyImported) {
      exitCode = EXIT_OK;
    } else if (outcome.result && outcome.result.status === 'failed') {
      logger.error(
        `${PROGRESS_TAG} import failed: ${outcome.result.error ?? 'unknown'}`,
      );
      exitCode = EXIT_IMPORT_FAILED;
    } else {
      exitCode = EXIT_OK;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${PROGRESS_TAG} Fatal error: ${msg}`);
    exitCode = EXIT_BOOTSTRAP;
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
  process.exit(exitCode);
}

// Запускается только как точка входа (node dist/cli/backfill-twic.js);
// тесты импортируют модуль и вызывают parseArgs/runBackfillTwic напрямую.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(EXIT_BOOTSTRAP);
  });
}
