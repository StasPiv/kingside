/**
 * KS-2438 / ADR-042 §1.2. Точка входа tactic-worker (NestJS standalone CLI).
 *
 * Поднимает `AppModule` через `NestFactory.createApplicationContext()`
 * (без HTTP-listener'а), парсит первый аргумент argv как subcommand и
 * вызывает соответствующий CLI-обработчик.
 *
 * Запуск через ECS RunTask:
 *   containerOverrides.command = ["node","dist/main.js","<subcommand>",...]
 *
 * Доступные subcommand'ы:
 *   - index-tactic-drills [args]     — drill-индексер (KS-2438 этап M0)
 *
 * В будущих этапах (§9.3 / §9.6 ADR-042) добавятся:
 *   - sf-validate-drills [args]      — Stockfish-валидатор drill'ов
 *   - generate-puzzles [args]        — puzzle-генератор (KS-2431)
 *   - validate-drill-positions       — one-shot maintenance
 *   - backfill-…/prune-…/rescore-…   — maintenance-скрипты
 *
 * Без аргументов — выводит help и exit=1, чтобы случайный default-RunTask
 * без override фейлил видимо (см. devops task-def §4.4 ADR).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { runIndexTacticDrills } from './cli/index-tactic-drills.cli';
import { runGeneratePuzzles } from './cli/generate-puzzles.cli';
import { runValidateEtalons } from './cli/validate-etalons.cli';
import { runDumpPuzzles } from './cli/dump-puzzles.cli';
import { runAnalyzePgn } from './cli/analyze-pgn.cli';
import { runBackfillPuzzleObjective } from './cli/backfill-puzzle-objective.cli';
import { runBackfillPhase } from './cli/backfill-phase.cli';
import { runBackfillEndgameSubtype } from './cli/backfill-endgame-subtype.cli';
import { runGeneratePuzzlesFromTwic } from './cli/generate-puzzles-from-twic.cli';

const SUBCOMMANDS = [
  'index-tactic-drills',
  'generate-puzzles',
  'validate-etalons',
  'dump-puzzles',
  'analyze-pgn',
  'backfill-puzzle-objective',
  'backfill-phase',
  'backfill-endgame-subtype',
  'generate-puzzles-from-twic',
] as const;

function printHelp(): void {
  process.stdout.write(
    `tactic-worker — NestJS standalone CLI (KS-2438 / ADR-042)\n\n` +
      `Usage:\n` +
      `  node dist/main.js <subcommand> [args]\n\n` +
      `Subcommands:\n` +
      `  index-tactic-drills   index drill positions from archive_games\n` +
      `                        (see --help for indexer flags)\n` +
      `  generate-puzzles      generate tactical puzzles from archive_games\n` +
      `                        (KS-2431 / ADR-041 etap 1 MVP)\n\n` +
      `Run via ECS RunTask:\n` +
      `  containerOverrides.command = ["node","dist/main.js","<subcommand>",...]\n`,
  );
}

async function main(): Promise<void> {
  const logger = new Logger('tactic-worker');
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    process.exit(subcommand ? 0 : 1);
  }

  if (!SUBCOMMANDS.includes(subcommand as (typeof SUBCOMMANDS)[number])) {
    process.stderr.write(
      `Unknown subcommand: ${subcommand}\nKnown: ${SUBCOMMANDS.join(', ')}\n`,
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  try {
    switch (subcommand) {
      case 'index-tactic-drills':
        await runIndexTacticDrills(app, rest);
        break;
      case 'generate-puzzles':
        await runGeneratePuzzles(app, rest);
        break;
      case 'validate-etalons':
        await runValidateEtalons(app, rest);
        break;
      case 'dump-puzzles':
        await runDumpPuzzles(app, rest);
        break;
      case 'analyze-pgn':
        await runAnalyzePgn(app, rest);
        break;
      case 'backfill-puzzle-objective':
        await runBackfillPuzzleObjective(app, rest);
        break;
      case 'backfill-phase':
        await runBackfillPhase(app, rest);
        break;
      case 'backfill-endgame-subtype':
        await runBackfillEndgameSubtype(app, rest);
        break;
      case 'generate-puzzles-from-twic':
        await runGeneratePuzzlesFromTwic(app, rest);
        break;
      default:
        // exhaustiveness — TypeScript уже проверил выше.
        throw new Error(`unhandled subcommand: ${subcommand}`);
    }
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  process.stderr.write(`✗ tactic-worker fatal: ${msg}\n`);
  process.exit(1);
});
