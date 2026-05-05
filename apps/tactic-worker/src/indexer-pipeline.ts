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
  findAllChecksMoves,
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
  /**
   * KS-2406 / KS-2408: счётчики «неучтённых» (dropped) кандидатов
   * по причинам. Нужны, чтобы видеть в логах: не выкашивают ли
   * новые фильтры слишком много позиций.
   *
   *   - `findForkUnsafeForker` (KS-2406) — позиций, где predicate
   *     `find-fork` нашёл fork-creating ход (clean по KS-2408), но
   *     фигура-форкер встала под бой и safety-фильтр отбросил.
   *     Если % очень велик — повод думать про SEE-вариант safety.
   *   - `findForkOverlap` (KS-2408) — позиций, где predicate
   *     `find-fork` нашёл ход с |targetsAfter|≥2, но множества
   *     целей форкера до и после хода пересекались (фигура
   *     продолжала атаковать кого-то из старых). Clean-creator'ов
   *     при этом не было.
   *   - `findUndefendedAttackUnsafeAttacker` (KS-2419) —
   *     зеркальный случай для `find-undefended-attack`: predicate
   *     нашёл creator-кандидата (новая висящая угроза), но
   *     атакующая фигура на m.to сама встала под бой → drop.
   */
  predicateDrops: {
    findForkUnsafeForker: number;
    findForkOverlap: number;
    findUndefendedAttackUnsafeAttacker: number;
  };
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
    predicateDrops: {
      findForkUnsafeForker: 0,
      findForkOverlap: 0,
      findUndefendedAttackUnsafeAttacker: 0,
    },
  };
}

/**
 * Применяет 7 предикатов к FEN, возвращает кандидатов (drills).
 * KS-2393: тип mate-in-1 удалён.
 *
 * KS-2406: опциональный `dropCounters` — для мониторинга «отсевов»
 * по причинам (сейчас только `findForkUnsafeForker`). Если не передан —
 * статистика не собирается (CLI / тесты, где она не нужна).
 */
export function predicatesForPosition(
  chess: Chess,
  options: IndexerOptions,
  source: string,
  dropCounters?: IndexerStats['predicateDrops'],
): PendingDrill[] {
  const fen = chess.fen();
  const out: PendingDrill[] = [];

  type SimplePredicateResult =
    | { valid: true; answer: AnswerData }
    | { valid: false; reason?: string };
  type SimplePredicate = {
    type: TacticDrillType;
    run: () => SimplePredicateResult;
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
    if (!r.valid) {
      // KS-2406 / KS-2408 / KS-2419: счётчики отсевов по причинам.
      // Reason выставляется в predicate'ах (find-fork.ts,
      // find-undefended-attack.ts).
      if (dropCounters) {
        if (p.type === 'find-fork') {
          if (r.reason === 'unsafe-forker') {
            dropCounters.findForkUnsafeForker += 1;
          } else if (r.reason === 'overlap-with-previous-attacks') {
            dropCounters.findForkOverlap += 1;
          }
        } else if (p.type === 'find-undefended-attack') {
          if (r.reason === 'unsafe-attacker') {
            dropCounters.findUndefendedAttackUnsafeAttacker += 1;
          }
        }
      }
      continue;
    }
    if (!r.answer) continue;
    const { bucket } = computeDifficulty(
      p.type,
      chess,
      r.answer,
      options.difficultyVersion,
    );
    // KS-2397: find-all-checks — пишем `meta.expectedMoves` (полный
    // список check-ходов как пары `{from, to}`). Фронт читает это
    // поле для рендера/валидации без необходимости в shape='moves'
    // миграции (KS-2325 остаётся в плане отдельно).
    let meta: Record<string, unknown> | undefined;
    if (p.type === 'find-all-checks') {
      const expectedMoves = findAllChecksMoves(fen);
      if (expectedMoves.length > 0) {
        meta = { expectedMoves };
      }
    }
    out.push({
      type: p.type,
      fen,
      answer: r.answer,
      difficulty: bucket,
      source,
      ...(meta ? { meta } : {}),
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
  // KS-2406 / KS-2408 / KS-2419: счётчики отсева по причинам —
  // важно видеть, не выкашивают ли фильтры слишком много.
  const drops =
    `drops:findFork.unsafeForker=${stats.predicateDrops.findForkUnsafeForker} ` +
    `findFork.overlap=${stats.predicateDrops.findForkOverlap} ` +
    `findUA.unsafeAttacker=` +
    `${stats.predicateDrops.findUndefendedAttackUnsafeAttacker}`;
  log(
    `[index] games=${stats.gamesProcessed} ` +
      `positions=${stats.positionsScanned} ` +
      `inserted=${stats.insertedTotal} ${targets} ${drops}`,
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
        const found = predicatesForPosition(
          replay,
          options,
          source,
          stats.predicateDrops,
        );
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
