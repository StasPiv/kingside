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

const SUBCOMMANDS = ['index-tactic-drills'] as const;

function printHelp(): void {
  process.stdout.write(
    `tactic-worker — NestJS standalone CLI (KS-2438 / ADR-042)\n\n` +
      `Usage:\n` +
      `  node dist/main.js <subcommand> [args]\n\n` +
      `Subcommands:\n` +
      `  index-tactic-drills   index drill positions from archive_games\n` +
      `                        (see --help for indexer flags)\n\n` +
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
