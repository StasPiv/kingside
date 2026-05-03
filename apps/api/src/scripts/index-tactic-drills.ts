/**
 * KS-2229 (ADR-035 §6.3, Drills E2). One-shot CLI-индексер позиций
 * для tactic-drill из TWIC-архива.
 *
 * Pipeline:
 *   1. Читать `archive_games` батчами (cursor pagination через `id`).
 *   2. Для каждой партии: `chess.loadPgn(g.pgn)`, перебираем all moves,
 *      на каждой position применяем 8 предикатов (KS-2227).
 *   3. Если `predicate.valid` — считаем difficulty (KS-2225 §9.10),
 *      собираем drill-row и пишем батчами через
 *      `prisma.tacticDrill.createMany({ skipDuplicates: true })` —
 *      дедуп через UNIQUE(type, fen) (KS-2229 миграция).
 *   4. Лог прогресса каждые `--log-every` партий, итог в конце.
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=...  DATABASE_URL=...  \
 *     npm run index:tactic-drills --workspace=@kingside/api -- \
 *       [--difficulty-version=v1|full]   default v1
 *       [--per-type-target=N]            default 3000 (methodology §3.2 MVP top)
 *       [--max-games=N]                  default Infinity (для smoke 100/1000)
 *       [--game-batch-size=N]            default 200
 *       [--insert-batch-size=N]          default 500
 *       [--log-every=N]                  default 50
 *       [--types=t1,t2,...]              ограничить набор drill-типов
 *
 * Завершение:
 *   - early stop когда все включённые drill-типы достигли target;
 *   - либо когда archive-БД заканчивается;
 *   - exit 0 при штатном выходе, exit 1 при ошибке.
 *
 * **Выполняется one-shot**, не в runtime API. На проде — ECS RunTask
 * на task-def kingside-api с `command: ["npm","run","index:tactic-drills"]`.
 */

import { Chess } from 'chess.js';
import { PrismaClient } from '@kingside/db';
import { PrismaClient as ArchivePrismaClient } from '@kingside/archive-db';
import type { TacticDrillType, AnswerData } from '@kingside/shared';
import {
  countAttackers,
  findAllChecks,
  findCountAttackersCandidates,
  findFork,
  findHangingPiece,
  findLoosePiece,
  findMateInOneSquare,
  findPin,
  findUndefendedAttack,
} from '../tactic-drill/predicates';
import { computeDifficulty } from '../tactic-drill/difficulty';

interface CliOptions {
  difficultyVersion: 'v1' | 'full';
  perTypeTarget: number;
  maxGames: number;
  gameBatchSize: number;
  insertBatchSize: number;
  logEvery: number;
  types: Set<TacticDrillType>;
}

const ALL_DRILL_TYPES: TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'find-all-checks',
  'count-attackers',
  'find-undefended-attack',
];

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    difficultyVersion: 'v1',
    perTypeTarget: 3000,
    maxGames: Infinity,
    gameBatchSize: 200,
    insertBatchSize: 500,
    logEvery: 50,
    types: new Set(ALL_DRILL_TYPES),
  };
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
          v.split(',').filter((t) => ALL_DRILL_TYPES.includes(t as TacticDrillType)) as TacticDrillType[],
        );
        if (opts.types.size === 0) {
          throw new Error('--types: empty whitelist after filtering');
        }
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  return opts;
}

interface PendingDrill {
  type: TacticDrillType;
  fen: string;
  answer: AnswerData;
  difficulty: number;
  source: string;
}

interface Stats {
  gamesProcessed: number;
  positionsScanned: number;
  drillsByType: Record<TacticDrillType, number>;
  insertedTotal: number;
}

function newStats(): Stats {
  return {
    gamesProcessed: 0,
    positionsScanned: 0,
    drillsByType: Object.fromEntries(
      ALL_DRILL_TYPES.map((t) => [t, 0]),
    ) as Record<TacticDrillType, number>,
    insertedTotal: 0,
  };
}

/**
 * Применяет все 8 предикатов к текущей FEN, возвращает массив
 * pending-drill'ов (один FEN может породить много drill'ов разных типов).
 */
function predicatesForPosition(
  chess: Chess,
  options: CliOptions,
  source: string,
): PendingDrill[] {
  const fen = chess.fen();
  const out: PendingDrill[] = [];

  type SimplePredicate = {
    type: TacticDrillType;
    run: () => { valid: boolean; answer?: AnswerData };
  };
  const simple: SimplePredicate[] = [
    { type: 'find-hanging-piece', run: () => findHangingPiece(fen) },
    { type: 'find-loose-piece', run: () => findLoosePiece(fen) },
    { type: 'find-pin', run: () => findPin(fen) },
    { type: 'find-fork', run: () => findFork(fen) },
    { type: 'find-mate-in-one-square', run: () => findMateInOneSquare(fen) },
    { type: 'find-all-checks', run: () => findAllChecks(fen) },
    { type: 'find-undefended-attack', run: () => findUndefendedAttack(fen) },
  ];

  for (const p of simple) {
    if (!options.types.has(p.type)) continue;
    const r = p.run();
    if (!r.valid || !r.answer) continue;
    const { bucket } = computeDifficulty(
      p.type,
      chess,
      r.answer,
      options.difficultyVersion,
    );
    out.push({
      type: p.type,
      fen,
      answer: r.answer,
      difficulty: bucket,
      source,
    });
  }

  // count-attackers — особый случай: один FEN порождает много
  // (square, color)-вариантов. Эти drill'ы хранят meta в `fen` (FEN
  // одинаков для всех вариантов) — для разных answer'ов FEN
  // одинаковый, поэтому unique(type, fen) нас режет: оставим только
  // **один** count-attackers-drill на FEN (первый кандидат). Это
  // приемлемо для MVP — вариативность даст KS-DRILL-INDEXER-INC.
  if (options.types.has('count-attackers')) {
    const cands = findCountAttackersCandidates(fen);
    if (cands.length > 0) {
      const c = cands[0];
      const r = countAttackers(fen, c.targetSquare, c.attackerColor);
      if (r.valid) {
        const { bucket } = computeDifficulty(
          'count-attackers',
          chess,
          r.answer,
          options.difficultyVersion,
        );
        out.push({
          type: 'count-attackers',
          fen,
          answer: r.answer,
          difficulty: bucket,
          source,
        });
      }
    }
  }

  return out;
}

async function flushBatch(
  prisma: PrismaClient,
  pending: PendingDrill[],
  stats: Stats,
): Promise<void> {
  if (pending.length === 0) return;
  const result = await prisma.tacticDrill.createMany({
    data: pending.map((p) => ({
      type: p.type,
      fen: p.fen,
      answer: p.answer as unknown as object,
      difficulty: p.difficulty,
      source: p.source,
    })),
    skipDuplicates: true,
  });
  stats.insertedTotal += result.count;
  // Атрибутируем по типам только реально вставленные. result.count
  // не разбит по типам, поэтому считаем по pending (счёт может
  // переоценивать на дубликаты — для лога сойдёт).
  for (const p of pending) stats.drillsByType[p.type]++;
}

function logProgress(stats: Stats, options: CliOptions): void {
  const targets = Array.from(options.types)
    .map((t) => `${t}=${stats.drillsByType[t]}/${options.perTypeTarget}`)
    .join(' ');
  process.stdout.write(
    `[index] games=${stats.gamesProcessed} ` +
      `positions=${stats.positionsScanned} ` +
      `inserted=${stats.insertedTotal} ${targets}\n`,
  );
}

function allTargetsReached(stats: Stats, options: CliOptions): boolean {
  for (const t of options.types) {
    if (stats.drillsByType[t] < options.perTypeTarget) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `[index] starting indexer ` +
      `version=${options.difficultyVersion} ` +
      `target=${options.perTypeTarget}/type ` +
      `types=${[...options.types].join(',')} ` +
      `maxGames=${options.maxGames === Infinity ? 'inf' : options.maxGames}\n`,
  );

  const prisma = new PrismaClient();
  const archive = new ArchivePrismaClient();
  const stats = newStats();
  const buffer: PendingDrill[] = [];

  try {
    let cursor: string | null = null;
    while (stats.gamesProcessed < options.maxGames && !allTargetsReached(stats, options)) {
      const games: { id: string; pgn: string }[] =
        await archive.archiveGame.findMany({
          take: options.gameBatchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          select: { id: true, pgn: true },
        });
      if (games.length === 0) break;
      cursor = games[games.length - 1].id;

      for (const g of games) {
        if (stats.gamesProcessed >= options.maxGames) break;
        if (allTargetsReached(stats, options)) break;
        stats.gamesProcessed++;

        const chess = new Chess();
        try {
          chess.loadPgn(g.pgn);
        } catch {
          continue; // битый PGN — пропускаем, не валим pipeline
        }

        // Перематываем игру с начала и шагаем вперёд, на каждой position
        // применяем предикаты.
        const history = chess.history({ verbose: true });
        const replay = new Chess();
        // позиция перед первым ходом — начальная FEN; позиции после
        // каждого хода — то, что drill-индексер хочет видеть.
        for (const m of history) {
          replay.move({ from: m.from, to: m.to, promotion: m.promotion });
          stats.positionsScanned++;
          const found = predicatesForPosition(replay, options, 'archive');
          for (const d of found) {
            if (stats.drillsByType[d.type] >= options.perTypeTarget) continue;
            buffer.push(d);
          }
          if (buffer.length >= options.insertBatchSize) {
            await flushBatch(prisma, buffer.splice(0), stats);
          }
        }

        if (stats.gamesProcessed % options.logEvery === 0) {
          logProgress(stats, options);
        }
      }
    }

    // Финальный flush.
    await flushBatch(prisma, buffer.splice(0), stats);
    logProgress(stats, options);
    process.stdout.write(
      `[index] done. games=${stats.gamesProcessed} ` +
        `positions=${stats.positionsScanned} inserted=${stats.insertedTotal}\n`,
    );
  } finally {
    await prisma.$disconnect();
    await archive.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    process.stderr.write(`✗ index-tactic-drills failed: ${msg}\n`);
    process.exit(1);
  });
}

export { parseArgs, predicatesForPosition };
