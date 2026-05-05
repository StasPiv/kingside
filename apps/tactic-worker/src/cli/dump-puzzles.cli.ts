/**
 * KS-2431. Subcommand `dump-puzzles` — выгрузить N свежих puzzle'ов
 * `source='generated'` в JSON-формате на stdout. Используется для
 * передачи sample'а chess-expert'у через CloudWatch (RDS из локального
 * контейнера агента не достижим, devops запускает на ECS, где prod
 * DATABASE_URL прописан в task-def secrets).
 *
 * Аргументы:
 *   --limit=N             default 30
 *   --order=newest|random  default newest (по createdAt DESC)
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CliOpts {
  limit: number;
  order: 'newest' | 'random';
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { limit: 30, order: 'newest' };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'limit':
        opts.limit = parseInt(v, 10);
        break;
      case 'order':
        if (v !== 'newest' && v !== 'random') {
          throw new Error(`--order must be newest|random, got ${v}`);
        }
        opts.order = v;
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return opts;
}

export async function runDumpPuzzles(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:dump-puzzles');
  const opts = parseArgs(argv);
  const prisma = app.get(PrismaService);

  const orderClause =
    opts.order === 'random' ? 'random()' : '"created_at" DESC';
  // Используем raw SQL вместо Prisma findMany — чтобы snake_case-имена
  // были видны как есть и не зависели от прогенеренной модели Prisma.
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, fen, moves, themes, rating, gap, depth,
            source_id AS "sourceId",
            source_move_num AS "sourceMoveNum",
            source_metadata AS "sourceMetadata",
            accepted_moves AS "acceptedMoves",
            created_at AS "createdAt"
     FROM puzzles
     WHERE source = 'generated' AND source_id IS NOT NULL
     ORDER BY ${orderClause}
     LIMIT $1`,
    opts.limit,
  )) as Array<Record<string, unknown>>;

  const dump = {
    count: rows.length,
    order: opts.order,
    generatedAt: new Date().toISOString(),
    puzzles: rows,
  };
  // BEGIN-DUMP / END-DUMP markers — чтобы было удобно вырезать из
  // CloudWatch потока даже если есть посторонние логи.
  process.stdout.write('=== KS-2431 PUZZLE DUMP BEGIN ===\n');
  process.stdout.write(JSON.stringify(dump, null, 2));
  process.stdout.write('\n=== KS-2431 PUZZLE DUMP END ===\n');
  logger.log(`dumped ${rows.length} puzzles to stdout`);
}
