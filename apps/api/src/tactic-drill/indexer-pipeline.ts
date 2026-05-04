/**
 * KS-2229 / KS-2245. Reusable pipeline индексации позиций
 * `archive_games → tactic_drills`. Используется CLI (`scripts/index-tactic-drills.ts`)
 * и NestJS-scheduler'ом (`tactic-drill-incremental.scheduler.ts`).
 *
 * Контракт:
 *   `runIndexer({ prisma, pg, options }) → Promise<IndexerStats>`
 *
 * Где `prisma` — клиент основной БД (запись в `tactic_drills`),
 * `pg` — открытый pg-клиент к archive-БД (чтение `archive_games`).
 *
 * KS-2245 incremental mode: cursor (UUID последней обработанной партии)
 * передаётся через `options.cursor`. Caller отвечает за персистенцию
 * нового cursor'а из `stats.lastCursor` (CLI пишет в stdout, scheduler
 * — в Redis).
 */
import { Chess } from 'chess.js';
import type { Client as PgClient } from 'pg';
import type { PrismaClient } from '@kingside/db';
import type {
  AnswerData,
  TacticDrillType,
} from '@kingside/shared';
import { DRILL_TYPE_ORDER } from '@kingside/shared';
import {
  countAttackers,
  findAllChecks,
  findCountAttackersCandidates,
  findFork,
  findHangingPiece,
  findLoosePiece,
  findPin,
  findUndefendedAttack,
  pickBestCandidate,
} from './predicates';
import { computeDifficulty } from './difficulty';

export interface IndexerOptions {
  difficultyVersion: 'v1' | 'full';
  perTypeTarget: number;
  maxGames: number;
  gameBatchSize: number;
  insertBatchSize: number;
  logEvery: number;
  types: Set<TacticDrillType>;
  /** UUID-cursor: брать партии с `id > cursor`. */
  cursor?: string | null;
  /** Логгер; default — process.stdout/stderr. */
  log?: (line: string) => void;
}

export interface IndexerStats {
  gamesProcessed: number;
  positionsScanned: number;
  drillsByType: Record<TacticDrillType, number>;
  insertedTotal: number;
  /** UUID последней обработанной партии (для incremental cursor). */
  lastCursor: string | null;
}

interface PendingDrill {
  type: TacticDrillType;
  fen: string;
  answer: AnswerData;
  difficulty: number;
  source: string;
  /**
   * KS-2328: UI-meta. Для `count-attackers` обязательно содержит
   * `highlightedSquare` и `attackerColor` — без них фронт не знает,
   * какую клетку подсвечивать. Для остальных типов сейчас undefined
   * (можно расширить позже под expectedCount и т. п.).
   */
  meta?: Record<string, unknown>;
}

const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

export function defaultIndexerOptions(): IndexerOptions {
  return {
    difficultyVersion: 'v1',
    perTypeTarget: 3000,
    maxGames: Infinity,
    gameBatchSize: 200,
    insertBatchSize: 500,
    logEvery: 50,
    types: new Set(ALL_DRILL_TYPES),
    cursor: null,
  };
}

function newStats(): IndexerStats {
  return {
    gamesProcessed: 0,
    positionsScanned: 0,
    drillsByType: Object.fromEntries(
      ALL_DRILL_TYPES.map((t) => [t, 0]),
    ) as Record<TacticDrillType, number>,
    insertedTotal: 0,
    lastCursor: null,
  };
}

/**
 * Применяет 7 предикатов к FEN, возвращает кандидатов (drills).
 * KS-2393: тип mate-in-1 удалён.
 */
export function predicatesForPosition(
  chess: Chess,
  options: IndexerOptions,
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
    // KS-2393: тип `mate-in-1 (deprecated)` удалён.
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

  if (options.types.has('count-attackers')) {
    const cands = findCountAttackersCandidates(fen);
    // KS-2329: до фикса бралось `cands[0]` — всегда a1/a2 при наличии
    // любой атаки. Теперь скорим кандидатов и берём «тактически
    // интересного» (атака на ценную фигуру противника, non-edge).
    const c = pickBestCandidate(fen, cands);
    if (c) {
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
          // KS-2328: без `meta.highlightedSquare` фронт не знает, какую
          // клетку подсвечивать в UI count-attackers (DrillRunner.tsx
          // читает drill.meta.highlightedSquare для squareStyles).
          meta: {
            highlightedSquare: c.targetSquare,
            attackerColor: c.attackerColor,
          },
        });
      }
    }
  }

  return out;
}

async function flushBatch(
  prisma: PrismaClient,
  pending: PendingDrill[],
  stats: IndexerStats,
): Promise<void> {
  if (pending.length === 0) return;
  const result = await prisma.tacticDrill.createMany({
    data: pending.map((p) => ({
      type: p.type,
      fen: p.fen,
      answer: p.answer as unknown as object,
      difficulty: p.difficulty,
      source: p.source,
      // KS-2328: meta нужно сохранять (для count-attackers — обязательно).
      ...(p.meta !== undefined ? { meta: p.meta as object } : {}),
    })),
    skipDuplicates: true,
  });
  stats.insertedTotal += result.count;
  for (const p of pending) stats.drillsByType[p.type]++;
}

function logProgress(
  stats: IndexerStats,
  options: IndexerOptions,
  log: (line: string) => void,
): void {
  const targets = Array.from(options.types)
    .map((t) => `${t}=${stats.drillsByType[t]}/${options.perTypeTarget}`)
    .join(' ');
  log(
    `[index] games=${stats.gamesProcessed} ` +
      `positions=${stats.positionsScanned} ` +
      `inserted=${stats.insertedTotal} ${targets}`,
  );
}

function allTargetsReached(
  stats: IndexerStats,
  options: IndexerOptions,
): boolean {
  for (const t of options.types) {
    if (stats.drillsByType[t] < options.perTypeTarget) return false;
  }
  return true;
}

export async function runIndexer(args: {
  prisma: PrismaClient;
  pg: PgClient;
  options: IndexerOptions;
  source?: string;
}): Promise<IndexerStats> {
  const { prisma, pg, options, source = 'archive' } = args;
  const log = options.log ?? ((l) => process.stdout.write(`${l}\n`));
  const stats = newStats();
  const buffer: PendingDrill[] = [];
  let cursor: string | null = options.cursor ?? null;

  while (
    stats.gamesProcessed < options.maxGames &&
    !allTargetsReached(stats, options)
  ) {
    const sql: string = cursor
      ? `SELECT id::text AS id, pgn FROM archive_games
         WHERE id > $1 ORDER BY id ASC LIMIT $2`
      : `SELECT id::text AS id, pgn FROM archive_games
         ORDER BY id ASC LIMIT $1`;
    const params: (string | number)[] = cursor
      ? [cursor, options.gameBatchSize]
      : [options.gameBatchSize];
    const res = await pg.query<{ id: string; pgn: string }>(sql, params);
    const games: { id: string; pgn: string }[] = res.rows;
    if (games.length === 0) break;
    cursor = games[games.length - 1].id;
    stats.lastCursor = cursor;

    for (const g of games) {
      if (stats.gamesProcessed >= options.maxGames) break;
      if (allTargetsReached(stats, options)) break;
      stats.gamesProcessed++;

      const chess = new Chess();
      try {
        chess.loadPgn(g.pgn);
      } catch {
        continue;
      }

      const history = chess.history({ verbose: true });
      const replay = new Chess();
      for (const m of history) {
        replay.move({ from: m.from, to: m.to, promotion: m.promotion });
        stats.positionsScanned++;
        const found = predicatesForPosition(replay, options, source);
        for (const d of found) {
          if (stats.drillsByType[d.type] >= options.perTypeTarget) continue;
          buffer.push(d);
        }
        if (buffer.length >= options.insertBatchSize) {
          await flushBatch(prisma, buffer.splice(0), stats);
        }
      }

      if (stats.gamesProcessed % options.logEvery === 0) {
        logProgress(stats, options, log);
      }
    }
  }

  await flushBatch(prisma, buffer.splice(0), stats);
  logProgress(stats, options, log);
  return stats;
}
