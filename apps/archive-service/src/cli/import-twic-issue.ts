/**
 * CLI shim: `node dist/cli/import-twic-issue.js <issue>` (KS-1679).
 *
 * Ad-hoc-импорт конкретного TWIC-выпуска по номеру. НЕ трогает
 * `archive_sources.cursor` — scheduler продолжит работать от своего
 * курсора. Используется для наращивания архива выпусками «назад» (1639,
 * 1638, …) с ручной проверкой метрик между итерациями.
 *
 * Делает Redis-`PUBLISH archive:imported` при `games_added > 0`, чтобы
 * HTTP-процесс archive-service сбросил кеш `/tree` и `/games`.
 *
 * Использует тот же Redis-lock `archive:import:lock:twic` что и
 * scheduler — параллельный scheduler-tick увидит `lock held, skipping`
 * и корректно пропустит свой заход (ADR-019 §2.11).
 *
 * KS-1720: bootstrap идёт через `AdHocCliModule` (без `ScheduleModule`,
 * без `ArchiveImportService`). Раньше использовался `ImporterModule` —
 * `ArchiveImportService.onModuleInit` делал immediate tick, брал lock и
 * ронял сам CLI с `lock held`. Любой ad-hoc после этого ждал TTL 30 мин.
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
import { acquireLockWithWait } from './lock-acquirer';
import {
  attachHeartbeat,
  buildLockValue,
  resolveLockTimings,
} from '../archive-import/archive-import-lock';
import { randomUUID } from 'node:crypto';

const PROGRESS_TAG = '[cli:import-twic-issue]';
const ARCHIVE_IMPORTED_CHANNEL = 'archive:imported';
const LOCK_KEY = 'archive:import:lock:twic';
/**
 * KS-1896: вместо мгновенного падения CLI ждёт освобождения lock'а до
 * 30 минут (нормальный TWIC-импорт занимает 12-18 минут — scheduled
 * importer + adhoc подряд должны помещаться в окно). Если не уложились
 * — реальная эскалация, exit 2.
 */
const LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 30 * 1000;

/**
 * Маркер, что lock не удалось взять за `LOCK_WAIT_TIMEOUT_MS` —
 * `main()` маппит в exit code 2 (отдельно от обычной фатальной ошибки).
 */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

export interface ImportTwicIssueArgs {
  issue: number;
}

/**
 * Парсит `process.argv.slice(2)` → `{ issue }`. Бросает ошибку с полной
 * подсказкой по usage при неверном вводе — CLI затем ловит и выходит
 * с кодом 1.
 */
export function parseArgs(argv: readonly string[]): ImportTwicIssueArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    throw new Error('Usage: import-twic-issue <issue>');
  }
  if (positional.length > 1) {
    throw new Error(
      `Expected exactly one positional argument (issue), got ${positional.length}: ${positional.join(', ')}`,
    );
  }
  const raw = positional[0];
  const issue = Number.parseInt(raw, 10);
  if (!Number.isFinite(issue) || issue <= 0 || String(issue) !== raw.trim()) {
    throw new Error(`Invalid issue number: "${raw}" (expected positive integer)`);
  }
  return { issue };
}

/**
 * Минимальный DI-surface для тестирования. `main()` собирает его через
 * `NestFactory.createApplicationContext`; тест подсовывает моки.
 *
 * KS-1896: `redis` теперь требует ещё и `get` — для проверки holder'а
 * во время wait-loop'а. `lockWaitOpts` — hooks для тестов (быстрый
 * sleep/now); в продовом `main()` не передаются и берутся дефолты.
 */
export interface ImportTwicIssueDeps {
  prisma: PrismaClient;
  // KS-1898: добавлен `eval` (Lua release/extend) — `del` больше не
  // нужен в финале, но оставлен для обратной совместимости тестов
  // и публичной поверхности `RedisService`.
  redis: Pick<Redis, 'set' | 'del' | 'publish' | 'get' | 'eval'>;
  makeImporter: (source: ArchiveSourceRow) => Pick<TwicImporter, 'runAdHoc'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** KS-1896: подмена `now`/`sleep` и параметров timeout'а (только для тестов). */
  lockWaitOpts?: {
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
  /** KS-1898: подмена heartbeat-таймеров (только для тестов). */
  lockHeartbeatOpts?: {
    setInterval?: (cb: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
  };
}

/**
 * Ядро CLI: достаёт `archive_sources.code='twic'`, берёт Redis-lock,
 * вызывает `TwicImporter.runAdHoc(issue)`, публикует событие при
 * `gamesAdded > 0`. Lock отпускается в finally.
 *
 * Возвращает `ImportResult` для анализа в main() / тестах.
 */
export async function runImportTwicIssue(
  deps: ImportTwicIssueDeps,
  args: ImportTwicIssueArgs,
): Promise<ImportResult> {
  const { prisma, redis, makeImporter, logger } = deps;

  const source = await prisma.archiveSource.findFirst({
    where: { code: 'twic' },
  });
  if (!source) {
    throw new Error('archive_sources row with code="twic" not found');
  }

  // KS-1898: значение lock'а — `<token>:adhoc:<issue>:<pid>`. Token —
  // UUID, защищает release/heartbeat от false-release при race
  // (Lua-скрипт сравнивает целое value). Meta-поля сохраняют
  // совместимость с KS-1896 duplicate-self detection (matcher
  // `:adhoc:<issue>:`).
  const token = randomUUID();
  const lockValue = buildLockValue(token, 'adhoc', args.issue, process.pid);
  const { ttlMs: lockTtlMs, heartbeatMs: lockHeartbeatMs } = resolveLockTimings(
    {},
  );

  // ARCHIVE_IMPORTER_LOCK_NO_WAIT=1 → старое поведение «упасть сразу».
  // Полезно для отладки и `cli-bootstrap` smoke-тестов в CI.
  const noWaitEnv = (process.env.ARCHIVE_IMPORTER_LOCK_NO_WAIT ?? '').toLowerCase();
  const noWait = noWaitEnv === '1' || noWaitEnv === 'true' || noWaitEnv === 'on';
  const waitTimeoutMs = noWait ? 0 : (deps.lockWaitOpts?.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS);
  const pollIntervalMs = deps.lockWaitOpts?.pollIntervalMs ?? LOCK_POLL_INTERVAL_MS;

  const wait = await acquireLockWithWait({
    redis,
    lockKey: LOCK_KEY,
    lockValue,
    // KS-1898: TTL передаём в секундах — `acquireLockWithWait` использует
    // `EX <sec>`. Точность округлим до секунды (clamp до 1).
    lockTtlSec: Math.max(1, Math.floor(lockTtlMs / 1000)),
    waitTimeoutMs,
    pollIntervalMs,
    isDuplicateSelf: (holder) =>
      // KS-1896 + KS-1898: holder теперь `<token>:adhoc:<issue>:<pid>`.
      // Проверяем, что role=adhoc и issue совпадает (без зависимости
      // от token/pid).
      holder !== null && holder.includes(`:adhoc:${args.issue}:`),
    logger,
    now: deps.lockWaitOpts?.now,
    sleep: deps.lockWaitOpts?.sleep,
  });

  if (!wait.acquired) {
    if (wait.reason === 'duplicate-self') {
      throw new Error(
        `lock "${LOCK_KEY}" already held by another adhoc CLI for the same issue ${args.issue} ` +
          `(holder=${wait.heldBy ?? 'unknown'}); refusing to wait — looks like a duplicate run`,
      );
    }
    if (wait.reason === 'timeout') {
      throw new LockTimeoutError(
        `lock "${LOCK_KEY}" still held after ${Math.floor(wait.waitedMs / 1000)}s ` +
          `(${wait.attempts} attempts, last holder=${wait.heldBy ?? 'unknown'}); aborting`,
      );
    }
    // 'no-wait-disabled' → старое сообщение, чтобы существующие
    // оркестраторы / парсеры логов не сломались.
    throw new Error(
      `lock "${LOCK_KEY}" is held — scheduler or another CLI is importing twic right now; ` +
        `try again in a minute (set ARCHIVE_IMPORTER_LOCK_NO_WAIT=0 or unset to enable wait)`,
    );
  }
  if (wait.waitedMs > 0) {
    logger.log(
      `${PROGRESS_TAG} acquired lock "${LOCK_KEY}" after ${Math.floor(wait.waitedMs / 1000)}s ` +
        `(${wait.attempts} attempt${wait.attempts === 1 ? '' : 's'})`,
    );
  }

  // KS-1898: SET уже сделал acquireLockWithWait. Привязываем heartbeat
  // (PEXPIRE через Lua) + token-safe release к этому value. После
  // SIGKILL Redis сам выпустит ключ через ≤ttlMs (без cleanup).
  const lock = attachHeartbeat({
    redis,
    key: LOCK_KEY,
    token,
    value: lockValue,
    ttlMs: lockTtlMs,
    heartbeatMs: lockHeartbeatMs,
    logger,
    setInterval: deps.lockHeartbeatOpts?.setInterval,
    clearInterval: deps.lockHeartbeatOpts?.clearInterval,
  });

  try {
    const importer = makeImporter({
      id: source.id,
      code: source.code,
      cursor: source.cursor ?? null,
    });
    logger.log(
      `${PROGRESS_TAG} issue=${args.issue} source.cursor=${source.cursor ?? 'null'} — starting ad-hoc import (cursor will NOT change)`,
    );
    // KS-2156: передаём lock.signal в importer. Если heartbeat потеряет
    // lock (Redis-flap / TTL истёк под нагрузкой), импорт прервётся
    // между chunk'ами и пометит archive_imports как failed.
    const result = await importer.runAdHoc(args.issue, { signal: lock.signal });
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
        // Кеш всё равно инвалидируется по TTL — не фатально.
        logger.warn(
          `${PROGRESS_TAG} redis publish failed (cache will TTL-expire): ${msg}`,
        );
      }
    }

    return result;
  } finally {
    // KS-1898: token-safe release. Если наш TTL истёк и ключ
    // перехвачен другим процессом, Lua вернёт 0 и DEL не сделает —
    // не сорвём чужой импорт. Heartbeat останавливается внутри release().
    await lock.release().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `${PROGRESS_TAG} failed to release ${LOCK_KEY} (relying on TTL=${lockTtlMs}ms): ${msg}`,
      );
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // KS-1720: используем `AdHocCliModule`, а не `ImporterModule`. Тот тянул
  // `ScheduleModule` + `ArchiveImportService` с `OnModuleInit`-immediate
  // tick'ом — при bootstrap ad-hoc CLI он успевал захватить
  // `archive:import:lock:twic`, после чего сам CLI падал с `lock held`,
  // а осиротевший lock блокировал любые ad-hoc запуски на 30 мин TTL.
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  const logger = new Logger('cli:import-twic-issue');
  let exitCode = 0;
  try {
    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    const writer = app.get(ArchivePositionWriterService);
    const indexer = app.get(PositionIndexerService);
    const metrics = app.get(ArchiveImportMetricsService);

    const result = await runImportTwicIssue(
      {
        prisma,
        redis,
        makeImporter: (source) =>
          new TwicImporter(prisma, source, writer, indexer, metrics),
        logger,
      },
      args,
    );

    if (result.status === 'failed') {
      // Невозможный URL, 5xx от TWIC, unzip-fail, DB error — все эти ветки
      // ставят status='failed' в `TwicImporter.runForIssue`. Помимо лога
      // нужен non-zero exit, чтобы оркестратор (bash-loop) остановился.
      logger.error(`${PROGRESS_TAG} import failed: ${result.error ?? 'unknown'}`);
      exitCode = 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LockTimeoutError) {
      // KS-1896: lock не отпустили за `LOCK_WAIT_TIMEOUT_MS`. Это
      // эскалация — оператору нужен отдельный exit-code, чтобы оркестратор
      // (CI / bash-loop) мог отличить «таймаут lock'а» от «импорт упал».
      logger.error(`${PROGRESS_TAG} Lock wait timed out: ${msg}`);
      exitCode = 2;
    } else {
      logger.error(`${PROGRESS_TAG} Fatal error: ${msg}`);
      exitCode = 1;
    }
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
  process.exit(exitCode);
}

// Запускаем только когда файл — точка входа (node dist/cli/import-twic-issue.js).
// В тестах файл импортируется — main() не вызывается (см. условие ниже),
// что позволяет проверить `parseArgs` / `runImportTwicIssue` независимо.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
