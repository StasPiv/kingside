/**
 * KS-2348 / KS-2342 — индексация tactic_drills из PGN-файла (one-shot).
 *
 * Альтернатива `index-tactic-drills.ts`, который ходит в archive-БД
 * (`archive_games`). Этот скрипт читает PGN напрямую с диска — удобно
 * когда archive-БД недоступна (например, ECS RunTask на проде без
 * доступа к archive-RDS, либо повторение dev-сидинга).
 *
 * Алгоритм:
 *   1. Читаем PGN, splitter по `[Event ...]`-маркерам — даёт список
 *      партий.
 *   2. Для каждой партии: replay по ходам через chess.js, на каждой
 *      позиции — `predicatesForPosition` (8 drill-типов из
 *      `indexer-pipeline.ts`).
 *   3. Локальный дедуп per-(type, fen) внутри сессии + БД-дедуп через
 *      UNIQUE(type, fen) с `skipDuplicates: true`.
 *   4. Пишем в `tactic_drills` с `source='indexed'` (как штатный
 *      индексер), batch'ами по `insertBatchSize`.
 *
 * Использование (production):
 *   DATABASE_URL=postgresql://... \
 *     node /app/apps/api/dist/scripts/index-pgn-oneshot.js \
 *       --pgn=/tmp/twic1567.pgn \
 *       --types=find-hanging-piece,find-pin
 *
 * Аргументы:
 *   --pgn=<path>              PGN-файл (обязательный).
 *   --max-games=<N|inf>       лимит партий (default Infinity).
 *   --types=<csv>             whitelist drill-типов (default — все 8).
 *   --difficulty-version=v1|full   default v1 (см. methodology §9.5).
 *   --insert-batch-size=<N>   default 500.
 *   --update-existing         (KS-2375) при коллизии по UNIQUE(type, fen)
 *                             обновлять answer/meta/difficulty
 *                             (UPSERT/ON CONFLICT DO UPDATE) вместо
 *                             пропуска. Нужен для быстрой раскатки
 *                             обновлённой логики predicate'ов на existing
 *                             банк без DELETE + полный re-index.
 *
 * ENV:
 *   - DATABASE_URL (только основная БД tactic_drills).
 *   - ARCHIVE_DATABASE_URL не нужен.
 *   - Redis/Stockfish не нужны.
 */

import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { PrismaClient } from '@kingside/db';
import type { TacticDrillType } from '@kingside/shared';
import { DRILL_TYPE_ORDER } from '@kingside/shared';
import { predicatesForPosition } from '../tactic-drill/indexer-pipeline';
import type { IndexerOptions } from '../tactic-drill/indexer-pipeline';

const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

interface CliOptions {
  pgnPath: string;
  maxGames: number;
  types: Set<TacticDrillType>;
  difficultyVersion: 'v1' | 'full';
  insertBatchSize: number;
  /**
   * KS-2375: при коллизии по UNIQUE(type, fen) обновлять answer/meta/
   * difficulty из новых predicate-результатов (UPSERT). Без флага —
   * skipDuplicates (старое поведение). Используется для быстрой
   * раскатки обновлённой логики predicate'ов на existing банк без
   * DELETE + полный re-index.
   */
  updateExisting: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let pgnPath = '';
  let maxGames: number = Number.POSITIVE_INFINITY;
  let types: Set<TacticDrillType> = new Set(ALL_DRILL_TYPES);
  let difficultyVersion: 'v1' | 'full' = 'v1';
  let insertBatchSize = 500;
  let updateExisting = false;

  for (const arg of argv) {
    const [key, val] = arg.replace(/^--/, '').split('=');
    switch (key) {
      case 'pgn':
        pgnPath = val ?? '';
        break;
      case 'max-games':
        maxGames = val === 'inf' ? Number.POSITIVE_INFINITY : parseInt(val, 10);
        break;
      case 'types': {
        const list = val
          .split(',')
          .filter((t) => ALL_DRILL_TYPES.includes(t as TacticDrillType));
        if (list.length === 0) {
          throw new Error('--types: empty after filtering');
        }
        types = new Set(list as TacticDrillType[]);
        break;
      }
      case 'difficulty-version':
        if (val !== 'v1' && val !== 'full') {
          throw new Error(`--difficulty-version must be v1|full, got ${val}`);
        }
        difficultyVersion = val;
        break;
      case 'insert-batch-size':
        insertBatchSize = parseInt(val, 10);
        break;
      case 'update-existing':
        // флаг без значения; допустимо `--update-existing` или `=true`.
        updateExisting = val === undefined || val === 'true';
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }

  if (!pgnPath) {
    throw new Error('--pgn=<path> is required');
  }
  return {
    pgnPath,
    maxGames,
    types,
    difficultyVersion,
    insertBatchSize,
    updateExisting,
  };
}

/** Splitter PGN: каждая партия начинается с `[Event ...]`-тега. */
function splitPgn(text: string): string[] {
  const games: string[] = [];
  let cur = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[Event ') && cur.trim().length > 0) {
      games.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur.trim().length > 0) games.push(cur);
  return games;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `[index-pgn] starting pgn=${cli.pgnPath} ` +
      `maxGames=${cli.maxGames === Infinity ? 'inf' : cli.maxGames} ` +
      `types=${[...cli.types].join(',')} ` +
      `difficulty=${cli.difficultyVersion} ` +
      `updateExisting=${cli.updateExisting}\n`,
  );

  const text = readFileSync(cli.pgnPath, 'utf8');
  const allGames = splitPgn(text);
  const games = Number.isFinite(cli.maxGames)
    ? allGames.slice(0, cli.maxGames)
    : allGames;
  process.stdout.write(
    `[index-pgn] PGN total available=${allGames.length}, processing=${games.length}\n`,
  );

  const prisma = new PrismaClient();

  const indexerOpts: IndexerOptions = {
    difficultyVersion: cli.difficultyVersion,
    perTypeTarget: Number.MAX_SAFE_INTEGER,
    maxGames: Number.POSITIVE_INFINITY,
    gameBatchSize: 200,
    insertBatchSize: cli.insertBatchSize,
    logEvery: 200,
    types: cli.types,
    cursor: null,
  };

  const stats = {
    gamesProcessed: 0,
    positionsScanned: 0,
    insertedTotal: 0,
    drillsByType: Object.fromEntries(
      ALL_DRILL_TYPES.map((t) => [t, 0]),
    ) as Record<TacticDrillType, number>,
  };

  const seen = new Set<string>();
  let pending: Array<{
    type: TacticDrillType;
    fen: string;
    answer: unknown;
    difficulty: number;
    /**
     * KS-2354: для count-attackers `predicatesForPosition` возвращает
     * `meta = { highlightedSquare, attackerColor }`. Раньше скрипт
     * терял это поле в `flush()`, и в БД попадали записи с `meta=NULL`.
     * Без `meta.highlightedSquare` фронт не подсвечивает клетку в drill'е.
     */
    meta?: Record<string, unknown>;
  }> = [];

  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    if (cli.updateExisting) {
      // KS-2375: UPSERT через ON CONFLICT DO UPDATE — обновляет answer/
      // meta/difficulty existing drill'ов под новые predicate-результаты.
      // Используется для быстрой раскатки KS-2371/2372 без DELETE +
      // полный re-index.
      //
      // NB: в `tactic_drills` нет колонки `updated_at`, поэтому в SET
      // её не трогаем (см. schema.prisma — есть только `createdAt`,
      // `sfValidatedAt`).
      //
      // RETURNING id даёт нам количество затронутых строк (включая
      // как INSERT, так и UPDATE — Postgres возвращает строку при
      // любом успешном ON CONFLICT DO UPDATE).
      let touched = 0;
      for (const p of pending) {
        const result = (await prisma.$queryRawUnsafe(
          `INSERT INTO tactic_drills
             (id, type, fen, answer, difficulty, source, meta, created_at)
           VALUES
             (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5,
              CASE WHEN $6::text IS NULL THEN NULL ELSE $6::jsonb END,
              NOW())
           ON CONFLICT (type, fen) DO UPDATE SET
             answer = EXCLUDED.answer,
             meta = EXCLUDED.meta,
             difficulty = EXCLUDED.difficulty
           RETURNING id`,
          p.type,
          p.fen,
          JSON.stringify(p.answer),
          p.difficulty,
          'indexed',
          p.meta !== undefined ? JSON.stringify(p.meta) : null,
        )) as unknown[];
        touched += Array.isArray(result) ? result.length : 0;
      }
      stats.insertedTotal += touched;
    } else {
      const result = await prisma.tacticDrill.createMany({
        data: pending.map((p) => ({
          type: p.type,
          fen: p.fen,
          answer: p.answer as object,
          difficulty: p.difficulty,
          source: 'indexed',
          // KS-2354: пробрасываем meta при наличии (count-attackers
          // требует highlightedSquare; для остальных типов
          // meta=undefined — Prisma оставит NULL, что корректно).
          ...(p.meta !== undefined ? { meta: p.meta as object } : {}),
        })),
        skipDuplicates: true,
      });
      stats.insertedTotal += result.count;
    }
    pending = [];
  }

  try {
    for (const pgn of games) {
      let chess: Chess;
      try {
        chess = new Chess();
        chess.loadPgn(pgn, { strict: false });
      } catch {
        continue;
      }
      const history = chess.history({ verbose: true });
      if (history.length === 0) continue;
      const replay = new Chess();
      for (const m of history) {
        try {
          replay.move({ from: m.from, to: m.to, promotion: m.promotion });
        } catch {
          break;
        }
        stats.positionsScanned++;
        const found = predicatesForPosition(replay, indexerOpts, 'indexed');
        for (const d of found) {
          const key = `${d.type}|${d.fen}`;
          if (seen.has(key)) continue;
          seen.add(key);
          stats.drillsByType[d.type]++;
          pending.push({
            type: d.type,
            fen: d.fen,
            answer: d.answer,
            difficulty: d.difficulty,
            // KS-2354: meta из предиката (count-attackers).
            meta: (d as { meta?: Record<string, unknown> }).meta,
          });
          if (pending.length >= cli.insertBatchSize) {
            await flush();
          }
        }
      }
      stats.gamesProcessed++;
      if (stats.gamesProcessed % indexerOpts.logEvery === 0) {
        process.stdout.write(
          `[index-pgn] games=${stats.gamesProcessed} ` +
            `positions=${stats.positionsScanned} ` +
            `inserted=${stats.insertedTotal} pending=${pending.length} ` +
            `byType=${JSON.stringify(stats.drillsByType)}\n`,
        );
      }
    }
    await flush();

    // Финальный count в БД per-type для source='indexed'.
    const final: Record<string, number> = {};
    for (const t of cli.types) {
      const c = await prisma.tacticDrill.count({
        where: { type: t, source: 'indexed' },
      });
      final[t] = c;
    }
    process.stdout.write(
      `[index-pgn] DONE games=${stats.gamesProcessed} ` +
        `positions=${stats.positionsScanned} ` +
        `unique-seen=${seen.size} inserted=${stats.insertedTotal}\n`,
    );
    process.stdout.write(
      `[index-pgn] DB counts (source=indexed): ${JSON.stringify(final)}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
