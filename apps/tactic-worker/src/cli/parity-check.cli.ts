/**
 * KS-4107. Одноразовый CLI для паритет-теста weakChoiceProb
 * client↔server после внедрения soft-threshold (metric_version=2) и
 * выравнивания серверного Stockfish (KS-4111: SF18 native).
 *
 * Что делает: для каждого `--ids=<id>,<id>,...` читает puzzle из БД,
 * получает Maia policy (ELO=1500), строит searchMoves, прогоняет SF
 * с MultiPV=searchMoves.length и `searchmoves`, собирает WDL и
 * expectedScores, считает `computeWeakChoiceProb` по soft-threshold —
 * и печатает JSON-массив объектов с ПОЛНЫМ трейсом (см.
 * `MaiaInspectResult`). QA подаёт тот же `FEN + firstMovePV1` в
 * клиентский путь (apps/web) и сверяет prob и weakSet.
 *
 * Запуск через ECS RunTask на проде (tactic-worker уже на SF18 native +
 * Maia ONNX в /app/tools/maia3):
 *
 *   containerOverrides.command = [
 *     "node","dist/main.js","parity-check",
 *     "--ids=754f93d5,aa9c8b2a,5830f706,712665fb"
 *   ]
 *
 * Опциональные флаги:
 *   --elo=1500       (default 1500)
 *   --depth=15       (default 15)
 *   --policy-top=12  (сколько top-policy ходов писать в JSON, default 12)
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MaiaAnnotationService } from '../maia/maia-annotation.service';
import { StockfishService } from '../stockfish/stockfish.service';

interface CliOpts {
  ids: string[];
  elo: number;
  depth: number;
  policyTop: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { ids: [], elo: 1500, depth: 15, policyTop: 12 };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'ids':
        opts.ids = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'elo':
        opts.elo = parseInt(v, 10);
        break;
      case 'depth':
        opts.depth = parseInt(v, 10);
        break;
      case 'policy-top':
        opts.policyTop = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  if (opts.ids.length === 0) {
    throw new Error('--ids is required (comma-separated puzzle ids)');
  }
  return opts;
}

export async function runParityCheck(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:parity-check');
  const opts = parseArgs(argv);
  logger.log(
    `parity-check ids=${opts.ids.length} elo=${opts.elo} depth=${opts.depth}`,
  );

  const prisma = app.get(PrismaService);
  const stockfish = app.get(StockfishService);

  // ENV-вариант, чтобы переиспользовать PRECISION_MAIA_MODEL_PATH /
  // PRECISION_MAIA_ANNOTATION_ELO / PRECISION_MAIA_SF_DEPTH из task-def,
  // и при необходимости переопределить через --elo / --depth ниже.
  const svc = MaiaAnnotationService.fromEnv(stockfish, {
    ...process.env,
    PRECISION_MAIA_ANNOTATION_ENABLED: 'true',
    PRECISION_MAIA_ANNOTATION_ELO: String(opts.elo),
    PRECISION_MAIA_SF_DEPTH: String(opts.depth),
  });

  // Тащим только нужные поля; sourceMetadata — JSON в БД.
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, fen,
            source_metadata AS "sourceMetadata"
       FROM puzzles
      WHERE id::text = ANY($1::text[])`,
    opts.ids,
  )) as Array<{
    id: string;
    fen: string;
    sourceMetadata: Record<string, unknown> | null;
  }>;

  const byId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byId.set(String(r.id), r);

  const out: Array<Record<string, unknown>> = [];
  for (const id of opts.ids) {
    const row = byId.get(id);
    if (!row) {
      out.push({ puzzleId: id, error: 'not_found' });
      logger.warn(`puzzle ${id}: not found`);
      continue;
    }
    const firstMovePV1 =
      row.sourceMetadata && typeof row.sourceMetadata === 'object'
        ? String(
            (row.sourceMetadata as Record<string, unknown>).firstMovePV1 ?? '',
          )
        : '';
    if (!firstMovePV1) {
      out.push({
        puzzleId: id,
        fen: row.fen,
        error: 'no_firstMovePV1_in_sourceMetadata',
      });
      logger.warn(`puzzle ${id}: no firstMovePV1 in sourceMetadata`);
      continue;
    }
    try {
      const trace = await svc.inspect(row.id, row.fen, firstMovePV1);
      out.push({
        ...trace,
        maiaPolicyTop: trace.maiaPolicyTop.slice(0, opts.policyTop),
      });
      logger.log(
        `puzzle ${id}: weakChoiceProb=${trace.weakChoiceProb.toFixed(4)} ` +
          `metric_version=${trace.metricVersion} weakSet=${trace.weakSet.length}`,
      );
    } catch (e) {
      out.push({
        puzzleId: id,
        fen: row.fen,
        firstMovePV1,
        error: (e as Error).message,
      });
      logger.error(`puzzle ${id}: ${(e as Error).message}`);
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
  process.stdout.write('\n');
}
