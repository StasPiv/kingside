/**
 * KS-2229 / KS-2245 (ADR-035 §6.3). One-shot CLI-индексер позиций для
 * tactic-drill из TWIC-архива.
 *
 * Сама pipeline-логика — в `apps/api/src/tactic-drill/indexer-pipeline.ts`
 * (`runIndexer`); используется и этим CLI, и cron-scheduler'ом
 * (`tactic-drill-incremental.scheduler.ts`, KS-2245).
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=postgresql://...  DATABASE_URL=postgresql://...  \
 *     npm run index:tactic-drills --workspace=@kingside/api -- \
 *       [--difficulty-version=v1|full]   default v1
 *       [--per-type-target=N]            default 3000 (methodology §3.2 MVP top)
 *       [--max-games=N]                  default Infinity (для smoke 100/1000)
 *       [--game-batch-size=N]            default 200
 *       [--insert-batch-size=N]          default 500
 *       [--log-every=N]                  default 50
 *       [--types=t1,t2,...]              ограничить набор drill-типов
 *       [--cursor=UUID]                  пропустить партии с id ≤ UUID
 *                                        (KS-2245 incremental: если задан,
 *                                         pipeline возьмёт партии с id > cursor)
 *
 * Завершение:
 *   - early stop когда все включённые drill-типы достигли target;
 *   - либо когда archive-БД заканчивается;
 *   - exit 0 при штатном выходе, exit 1 при ошибке.
 *   - в stdout пишется `lastCursor=<uuid>` — для интеграции с
 *     deploy-pipeline (можно пайпать в env / Redis вне процесса).
 *
 * **Выполняется one-shot**, не в runtime API. На проде — ECS RunTask
 * на task-def kingside-api с `command: ["npm","run","index:tactic-drills"]`.
 * KS-2245 incremental ENV-вариант — через NestJS scheduler в api,
 * не через этот CLI.
 */

import { Client as PgClient } from 'pg';
import { PrismaClient } from '@kingside/db';
import type { TacticDrillType } from '@kingside/shared';
import { DRILL_TYPE_ORDER } from '@kingside/shared';
import {
  defaultIndexerOptions,
  predicatesForPosition,
  runIndexer,
  type IndexerOptions,
} from '../tactic-drill/indexer-pipeline';
import { buildArchivePgClientConfig } from '../tactic-drill/pg-ssl';

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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

  const prisma = new PrismaClient();
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
    await prisma.$disconnect();
    await pg.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    process.stderr.write(`✗ index-tactic-drills failed: ${msg}\n`);
    process.exit(1);
  });
}

// Для совместимости с прежним spec'ом KS-2229.
export { predicatesForPosition };
