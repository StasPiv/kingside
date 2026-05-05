/**
 * KS-2438 / ADR-042 §9.1. CLI subcommand `index-tactic-drills`.
 *
 * Перенесён из `apps/api/src/scripts/index-tactic-drills.ts` (KS-2229,
 * KS-2245). Логика индексации — в `../indexer-pipeline.ts`
 * (`runIndexer`); CLI обёртка собирает options из argv, открывает
 * pg-клиент к archive-RDS (с явным CA через `pg-ssl.ts`) и вызывает
 * pipeline.
 *
 * Контракт CLI (как раньше, флаги совместимы со scheduler'ом api):
 *   ARCHIVE_DATABASE_URL=postgresql://...  DATABASE_URL=postgresql://...  \
 *     node dist/main.js index-tactic-drills \
 *       [--difficulty-version=v1|full]   default v1
 *       [--per-type-target=N]            default 3000
 *       [--max-games=N]                  default Infinity (smoke: 1/100/1000)
 *       [--game-batch-size=N]            default 200
 *       [--insert-batch-size=N]          default 500
 *       [--log-every=N]                  default 50
 *       [--types=t1,t2,...]              ограничить набор drill-типов
 *       [--cursor=UUID]                  пропустить партии с id ≤ UUID
 *
 * Завершение:
 *   - early stop когда все включённые drill-типы достигли target;
 *   - либо когда archive-БД заканчивается;
 *   - exit 0 при штатном выходе, exit 1 при ошибке;
 *   - в stdout пишется `lastCursor=<uuid>` — для интеграции с
 *     EventBridge / cursor-Redis вне процесса.
 *
 * Запуск на ECS — RunTask на task-def `kingside-tactic-worker` c
 * `containerOverrides.command = ["node","dist/main.js","index-tactic-drills",...]`.
 */
import { Logger } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import type { INestApplicationContext } from '@nestjs/common';
import type { TacticDrillType } from '@kingside/shared';
import { DRILL_TYPE_ORDER } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  defaultIndexerOptions,
  predicatesForPosition,
  runIndexer,
  type IndexerOptions,
} from '../indexer-pipeline';
import { buildArchivePgClientConfig } from '../lib/pg-ssl';

const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

export function parseArgs(argv: string[]): IndexerOptions {
  const opts = defaultIndexerOptions();
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'difficulty-version':
        if (v !== 'v1' && v !== 'full') {
          throw new Error(`--difficulty-version must be v1|full, got ${v}`);
        }
        opts.difficultyVersion = v;
        break;
      case 'per-type-target':
        opts.perTypeTarget = parseInt(v, 10);
        break;
      case 'max-games':
        opts.maxGames = v === 'inf' ? Infinity : parseInt(v, 10);
        break;
      case 'game-batch-size':
        opts.gameBatchSize = parseInt(v, 10);
        break;
      case 'insert-batch-size':
        opts.insertBatchSize = parseInt(v, 10);
        break;
      case 'log-every':
        opts.logEvery = parseInt(v, 10);
        break;
      case 'types':
        opts.types = new Set(
          v
            .split(',')
            .filter((t) =>
              ALL_DRILL_TYPES.includes(t as TacticDrillType),
            ) as TacticDrillType[],
        );
        if (opts.types.size === 0) {
          throw new Error('--types: empty whitelist after filtering');
        }
        break;
      case 'cursor':
        opts.cursor = v;
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return opts;
}

/**
 * Запуск CLI-команды. Принимает уже поднятый Nest-context (для
 * получения PrismaService) и argv (без subcommand, как в scheduler'ах
 * archive-service).
 */
export async function runIndexTacticDrills(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:index-tactic-drills');
  const options = parseArgs(argv);

  process.stdout.write(
    `[index] starting indexer ` +
      `version=${options.difficultyVersion} ` +
      `target=${options.perTypeTarget}/type ` +
      `types=${[...options.types].join(',')} ` +
      `cursor=${options.cursor ?? 'none'} ` +
      `maxGames=${options.maxGames === Infinity ? 'inf' : options.maxGames}\n`,
  );

  const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!archiveUrl) {
    throw new Error(
      'ARCHIVE_DATABASE_URL env not set; need read-access to archive_games',
    );
  }

  const prisma = app.get(PrismaService);
  // KS-2411: явный verify-full SSL для archive-RDS — заменяет
  // NODE_TLS_REJECT_UNAUTHORIZED=0 в RunTask'ах.
  const pgConfig = buildArchivePgClientConfig(
    archiveUrl,
    process.env,
    undefined,
    (msg) => process.stderr.write(`[index] WARN: ${msg}\n`),
  );
  const pg = new PgClient(pgConfig);
  await pg.connect();
  try {
    const stats = await runIndexer({ prisma, pg, options });
    process.stdout.write(
      `[index] done. games=${stats.gamesProcessed} ` +
        `positions=${stats.positionsScanned} ` +
        `inserted=${stats.insertedTotal} ` +
        `lastCursor=${stats.lastCursor ?? 'none'}\n`,
    );
  } finally {
    await pg.end().catch((err) => {
      logger.warn(`pg.end failed: ${(err as Error).message}`);
    });
  }
}

// Для совместимости со spec'ом KS-2229.
export { predicatesForPosition };
