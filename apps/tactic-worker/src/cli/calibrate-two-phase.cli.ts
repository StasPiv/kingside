/**
 * KS-3387 / ADR-083 §7 — калибровочный эксперимент двухфазной генерации.
 *
 * Цель: подобрать `screenNodeLimit` и `screenDeltaMargin` для фазы 1
 * (cheap screen) так, чтобы recall истинных зевков был ≥ 99% при
 * максимальном отсеве (выигрыше).
 *
 * Метод (single-pass eval-curve, симметрично эталону и screen):
 *   1. Выбираем N случайных партий из archive_games (Elo ≥ R).
 *   2. Эталон (deep): eval-кривая на `--deep-nodes` (10M) →
 *      deepDeltaW каждого ply. Истинные зевки B_true = ply с
 *      deepDeltaW ≥ deltaWThreshold (0.6, ADR-068). samePv1/after-фильтр
 *      НЕ применяем — они общие для обеих фаз и на recall фазы 1 не
 *      влияют (фаза 1 их не делает; фаза 2 применит одинаково). Для
 *      recall(margin) важна именно delta-составляющая.
 *   3. Screen (cheap): для каждого `screenNodeLimit` ∈ списка —
 *      eval-кривая на дешёвом лимите → approxDeltaW каждого ply.
 *   4. recall(margin): для сетки margin процент B_true с
 *      `approxDeltaW ≥ (threshold − margin)`.
 *   5. % отсева: доля ВСЕХ ply, отброшенных при данном (nodeLimit,
 *      margin). Фактический выигрыш ≈ 1 / (доля кандидатов × 1.7).
 *   6. Замер времени deep vs screen.
 *
 * Вывод — JSON между маркерами `=== KS-3387 CALIBRATION BEGIN/END ===`
 * (для извлечения из CloudWatch). Backend оформляет артефакт
 * `docs/qa/two-phase-puzzle-gen-calibration-<date>.md` из этого вывода.
 *
 * Контракт CLI:
 *   ARCHIVE_DATABASE_URL=... \
 *     node dist/main.js calibrate-two-phase \
 *       [--limit=N]               число партий (default 50)
 *       [--min-rating=R]          Elo-фильтр обоих игроков (default 2400)
 *       [--start-ply=N]           (default 20)
 *       [--deep-nodes=N]          эталонный лимит (default 10000000)
 *       [--screen-nodes=a,b,c]    список cheap-лимитов (default 100000,250000,500000)
 *       [--delta-threshold=W]     порог истинного зевка (default 0.6)
 *       [--seed-cursor=UUID]      детерминизм выборки (опц.; иначе random())
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import {
  replayPgnToSteps,
  invertWdl,
  wdlOrMateFallback,
  type PlyStep,
  type Wdl,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../stockfish/stockfish.service';
import { buildArchivePgClientConfig } from '../lib/pg-ssl';
import type { AnalysisLimit } from '../stockfish/stockfish.service';

interface CalibFlags {
  limit: number;
  minRating: number;
  startPly: number;
  deepNodes: number;
  screenNodes: number[];
  deltaThreshold: number;
}

export function parseArgs(argv: string[]): CalibFlags {
  const f: CalibFlags = {
    limit: 50,
    minRating: 2400,
    startPly: 20,
    deepNodes: 10_000_000,
    screenNodes: [100_000, 250_000, 500_000],
    deltaThreshold: 0.6,
  };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'limit':
        f.limit = parseInt(v, 10);
        break;
      case 'min-rating':
        f.minRating = parseInt(v, 10);
        break;
      case 'start-ply':
        f.startPly = parseInt(v, 10);
        break;
      case 'deep-nodes':
        f.deepNodes = parseInt(v, 10);
        break;
      case 'screen-nodes':
        f.screenNodes = v
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case 'delta-threshold':
        f.deltaThreshold = parseFloat(v);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  if (!Number.isFinite(f.limit) || f.limit <= 0) {
    throw new Error(`bad --limit: ${f.limit}`);
  }
  if (f.screenNodes.length === 0) {
    throw new Error('empty --screen-nodes');
  }
  return f;
}

interface GameRow {
  id: string;
  pgn: string;
  white_elo: number | null;
  black_elo: number | null;
}

/** Adapter StockfishService → minimal analyze для заданного лимита. */
function makeEngine(sf: StockfishService, limit: AnalysisLimit) {
  return {
    analyze: async (fen: string, multiPV: number, label?: string) => {
      const lines = await sf.analyzePositionWdl(fen, limit, multiPV, label);
      return lines.map((l) => ({ wdl: l.wdl, score: l.score }));
    },
  };
}

/**
 * Single-pass eval-кривая: для каждого ply считает deltaW (POV
 * зевнувшего) на заданном движке. Дедуп позиций через кэш
 * (fenAfter[i] == fenBefore[i+1]). Возвращает Map<ply, deltaW|null>
 * (null — терминал/нет eval) и число фактических analyze-вызовов.
 */
async function computeDeltaCurve(
  steps: PlyStep[],
  engine: ReturnType<typeof makeEngine>,
): Promise<{ deltas: Map<number, number | null>; analyzeCalls: number }> {
  const cache = new Map<string, Wdl | null>();
  let analyzeCalls = 0;

  const evalWhite = async (
    fen: string,
    sideToMove: 'w' | 'b',
  ): Promise<Wdl | null> => {
    if (cache.has(fen)) return cache.get(fen)!;
    analyzeCalls++;
    let raw: Wdl | null = null;
    try {
      const lines = await engine.analyze(fen, 1, `calib ${fen.slice(0, 12)}`);
      if (lines.length > 0 && lines[0]) {
        raw = wdlOrMateFallback(lines[0].wdl, lines[0].score);
      }
    } catch {
      raw = null;
    }
    const white = raw == null ? null : sideToMove === 'w' ? raw : invertWdl(raw);
    cache.set(fen, white);
    return white;
  };

  const deltas = new Map<number, number | null>();
  for (const step of steps) {
    if (step.isGameOverAfter) {
      deltas.set(step.ply, null); // терминал — фаза 2 решает (консервативно)
      continue;
    }
    const before = await evalWhite(step.fenBefore, step.preventiveSolverSide);
    const after = await evalWhite(step.fenAfter, step.reactiveSolverSide);
    if (before == null || after == null) {
      deltas.set(step.ply, null);
      continue;
    }
    const side = step.preventiveSolverSide;
    const wBefore = side === 'w' ? before.w : before.l;
    const wAfter = side === 'w' ? after.w : after.l;
    deltas.set(step.ply, (wBefore - wAfter) / 1000);
  }
  return { deltas, analyzeCalls };
}

/** Сетка margin для recall-кривой: 0, 0.05, ..., 0.60. */
const MARGIN_GRID = Array.from({ length: 13 }, (_, i) => +(i * 0.05).toFixed(2));

export async function runCalibrateTwoPhase(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:calibrate-two-phase');
  const flags = parseArgs(argv);
  const sf = app.get(StockfishService);
  // PrismaService нужен только чтобы поднять модуль; выборку делаем
  // прямым pg к archive RDS (как остальные puzzle-gen CLI).
  app.get(PrismaService);

  const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
  if (!archiveUrl) {
    throw new Error('ARCHIVE_DATABASE_URL not set');
  }
  const pgConfig = buildArchivePgClientConfig(
    archiveUrl,
    process.env,
    undefined,
    (m) => process.stderr.write(`[calib] WARN: ${m}\n`),
  );
  const pg = new PgClient(pgConfig);
  await pg.connect();

  process.stdout.write(
    `[calib] start limit=${flags.limit} minRating=${flags.minRating} ` +
      `startPly=${flags.startPly} deepNodes=${flags.deepNodes} ` +
      `screenNodes=[${flags.screenNodes.join(',')}] ` +
      `deltaThreshold=${flags.deltaThreshold}\n`,
  );

  try {
    const gamesRes = await pg.query<GameRow>(
      `SELECT id::text AS id, pgn, white_elo, black_elo
         FROM archive_games
        WHERE pgn IS NOT NULL
          AND white_elo >= $1 AND black_elo >= $1
        ORDER BY random()
        LIMIT $2`,
      [flags.minRating, flags.limit],
    );
    const games = gamesRes.rows;
    process.stdout.write(`[calib] fetched ${games.length} games\n`);

    const deepEngine = makeEngine(sf, { nodes: flags.deepNodes });

    // Аккумуляторы по всем партиям.
    // trueBlunders: для каждого истинного зевка — его approxDeltaW при
    //   каждом screenNodeLimit (или null если terminal/no-eval в screen).
    const trueBlunders: Array<{
      gameId: string;
      ply: number;
      deepDeltaW: number;
      screenApprox: Record<number, number | null>;
    }> = [];
    let totalPly = 0;
    // Для % отсева: распределение approxDeltaW всех ply per screenNodeLimit.
    const allScreenDeltas: Record<number, Array<number | null>> = {};
    for (const sn of flags.screenNodes) allScreenDeltas[sn] = [];

    // Детерминированный учёт стоимости: число analyze-вызовов per фаза
    // (× nodeLimit = пропорциональная CPU-стоимость). Wall-clock мерим
    // отдельно — при параллелизме per-phase Date.now перекрывались бы.
    let deepAnalyzeCalls = 0;
    const screenAnalyzeCalls: Record<number, number> = {};
    for (const sn of flags.screenNodes) screenAnalyzeCalls[sn] = 0;

    // Параллелизм между партиями: насыщаем Stockfish-пул. Внутри партии
    // computeDeltaCurve последовательна (нужен дедуп-кэш). concurrency
    // = STOCKFISH_POOL_SIZE (больше нет смысла — позиции встанут в
    // waitQueue пула).
    const concurrency = Math.max(
      1,
      Number(process.env.STOCKFISH_POOL_SIZE ?? 1) || 1,
    );
    const wallStart = Date.now();
    let processed = 0;
    let nextIdx = 0;

    const processOneGame = async (game: GameRow): Promise<void> => {
      const replay = replayPgnToSteps(game.pgn, flags.startPly);
      if ('error' in replay) {
        process.stdout.write(`[calib] skip game=${game.id}: ${replay.error}\n`);
        return;
      }
      const steps = replay.steps;
      if (steps.length === 0) return;
      totalPly += steps.length;

      // Эталон (deep) — single-pass eval-curve.
      const deep = await computeDeltaCurve(steps, deepEngine);
      deepAnalyzeCalls += deep.analyzeCalls;

      // Screen — по каждому лимиту.
      const screenDeltasByNode: Record<number, Map<number, number | null>> = {};
      for (const sn of flags.screenNodes) {
        const eng = makeEngine(sf, { nodes: sn });
        const sc = await computeDeltaCurve(steps, eng);
        screenAnalyzeCalls[sn] += sc.analyzeCalls;
        screenDeltasByNode[sn] = sc.deltas;
        for (const step of steps) {
          allScreenDeltas[sn].push(sc.deltas.get(step.ply) ?? null);
        }
      }

      // Истинные зевки по эталону.
      for (const step of steps) {
        const dd = deep.deltas.get(step.ply);
        if (dd != null && dd >= flags.deltaThreshold) {
          const screenApprox: Record<number, number | null> = {};
          for (const sn of flags.screenNodes) {
            screenApprox[sn] = screenDeltasByNode[sn].get(step.ply) ?? null;
          }
          trueBlunders.push({
            gameId: game.id,
            ply: step.ply,
            deepDeltaW: dd,
            screenApprox,
          });
        }
      }

      processed++;
      if (processed % 5 === 0) {
        process.stdout.write(
          `[calib] progress games=${processed}/${games.length} ` +
            `trueBlunders=${trueBlunders.length} totalPly=${totalPly}\n`,
        );
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, games.length) }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= games.length) return;
          await processOneGame(games[idx]);
        }
      }),
    );
    const wallClockSec = (Date.now() - wallStart) / 1000;

    // recall(margin) и % отсева per (nodeLimit, margin).
    const threshold = flags.deltaThreshold;
    const recallCurves: Record<
      number,
      Array<{
        margin: number;
        screenThreshold: number;
        recall: number;
        dropRate: number;
        estSpeedup: number;
      }>
    > = {};

    for (const sn of flags.screenNodes) {
      recallCurves[sn] = [];
      const screenDeltas = allScreenDeltas[sn];
      const totalCandidatesDenom = screenDeltas.length || 1;
      for (const margin of MARGIN_GRID) {
        const screenThreshold = threshold - margin;
        // recall: доля истинных зевков, прошедших фазу 1. null approx
        // (терминал/no-eval) трактуем как ПРОШЁЛ (консервативно — фаза 1
        // их пропускает в фазу 2).
        let passed = 0;
        for (const b of trueBlunders) {
          const a = b.screenApprox[sn];
          if (a == null || a >= screenThreshold) passed++;
        }
        const recall = trueBlunders.length > 0 ? passed / trueBlunders.length : 1;
        // candidates: доля всех ply, попавших в фазу 2 (null = кандидат).
        let candidates = 0;
        for (const a of screenDeltas) {
          if (a == null || a >= screenThreshold) candidates++;
        }
        const candidateRate = candidates / totalCandidatesDenom;
        const dropRate = 1 - candidateRate;
        // Грубая модель выигрыша: screen стоит ~(sn/deepNodes) от deep на
        // позицию. Полный baseline ~1.7 deep-прогона/ply. Двухфаза:
        // screen на всех + 1.7 deep на кандидатах.
        const screenCostFrac = sn / flags.deepNodes;
        const twoPhaseCost = screenCostFrac + candidateRate * 1.7;
        const baselineCost = 1.7;
        const estSpeedup = twoPhaseCost > 0 ? baselineCost / twoPhaseCost : 0;
        recallCurves[sn].push({
          margin,
          screenThreshold: +screenThreshold.toFixed(3),
          recall: +recall.toFixed(4),
          dropRate: +dropRate.toFixed(4),
          estSpeedup: +estSpeedup.toFixed(2),
        });
      }
    }

    const report = {
      meta: {
        ks: 'KS-3387',
        adr: 'ADR-083',
        generatedAt: new Date().toISOString(),
        flags,
        gamesFetched: games.length,
        gamesProcessed: processed,
        totalPly,
        trueBlunderCount: trueBlunders.length,
        concurrency,
        wallClockSec: +wallClockSec.toFixed(1),
        // Детерминированная CPU-стоимость: analyze-вызовы × nodeLimit.
        deepAnalyzeCalls,
        screenAnalyzeCalls,
      },
      // Рекомендация: минимальный (nodeLimit, margin) с recall ≥ 0.99.
      recallTarget: 0.99,
      recallCurves,
      // Сырые точки (для перепостроения кривых при необходимости).
      trueBlunders,
    };

    process.stdout.write('=== KS-3387 CALIBRATION BEGIN ===\n');
    process.stdout.write(JSON.stringify(report, null, 2));
    process.stdout.write('\n=== KS-3387 CALIBRATION END ===\n');
    logger.log(
      `calibration done: ${trueBlunders.length} true blunders over ${totalPly} ply`,
    );
  } finally {
    await pg.end().catch(() => undefined);
  }
}
