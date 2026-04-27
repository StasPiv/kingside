#!/usr/bin/env node
/**
 * KS-2017 / B-1 — CLI lesson-import.
 *
 * Команды:
 *  - `lesson-import validate <path>`            — только AJV-валидация.
 *  - `lesson-import dry-run  <path> --base-url` — валидация + GET текущего
 *      состояния курса/уроков из API + diff. Без записи.
 *  - `lesson-import import   <path> --base-url --token` — то же, что dry-run,
 *      плюс POST /lessons/admin/import.
 *  - `lesson-import export   --course <slug> --base-url --out <dir>` —
 *      GET курса по slug, генерация course.yml + *.lesson.yml в out-dir.
 *
 * Все команды печатают человекочитаемые ошибки и возвращают exit 0/1.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadBundle, ValidationFailure } from './parser.js';
import { formatErrors } from './errors.js';
import { AdminApiClient } from './api-client.js';
import { diffBundle } from './diff.js';
import { formatBundleDiff } from './diff-print.js';
import { upsertBundle } from './upserter.js';
import { exportCourse } from './exporter.js';

interface CommonOpts {
  color?: boolean;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('lesson-import')
    .description('CLI для импорта/экспорта/валидации YAML-файлов курса (KS-2015 / B-1).')
    .option('--no-color', 'отключить цветной вывод')
    .version('0.0.1');

  program
    .command('validate')
    .description('Парсит YAML и валидирует против @kingside/lesson-schema. Без сетевых вызовов.')
    .argument('<path>', 'файл *.lesson.yml / course.yml или директория курса')
    .action(async (path: string, _opts: unknown, cmd: Command) => {
      const opts = pickCommon(cmd);
      process.exitCode = await runValidate(path, opts);
    });

  program
    .command('dry-run')
    .description('Валидация + diff с текущим состоянием API (без записи).')
    .argument('<path>')
    .requiredOption('--base-url <url>', 'URL admin API (например, http://localhost:3001)')
    .option('--token <bearer>', 'Bearer token (admin)')
    .action(async (path: string, cmdOpts: { baseUrl: string; token?: string }, cmd: Command) => {
      const opts = pickCommon(cmd);
      process.exitCode = await runDryRun(path, cmdOpts.baseUrl, cmdOpts.token, opts);
    });

  program
    .command('import')
    .description('Валидация + diff + POST /lessons/admin/import (B-3).')
    .argument('<path>')
    .requiredOption('--base-url <url>')
    .option('--token <bearer>')
    .option('--yes', 'не спрашивать подтверждение перед записью')
    .action(
      async (
        path: string,
        cmdOpts: { baseUrl: string; token?: string; yes?: boolean },
        cmd: Command,
      ) => {
        const opts = pickCommon(cmd);
        process.exitCode = await runImport(
          path,
          cmdOpts.baseUrl,
          cmdOpts.token,
          !!cmdOpts.yes,
          opts,
        );
      },
    );

  program
    .command('export')
    .description('GET курса по slug, запись course.yml + *.lesson.yml в --out.')
    .requiredOption('--course <slug>')
    .requiredOption('--base-url <url>')
    .requiredOption('--out <dir>')
    .option('--token <bearer>')
    .option('--dry-run', 'не писать файлы, только показать что будет сгенерировано')
    .action(
      async (cmdOpts: {
        course: string;
        baseUrl: string;
        out: string;
        token?: string;
        dryRun?: boolean;
      }) => {
        process.exitCode = await runExport(cmdOpts);
      },
    );

  return program;
}

function pickCommon(cmd: Command): CommonOpts {
  // Чтобы получить --no-color с глобального уровня.
  let p: Command | null = cmd;
  while (p?.parent) p = p.parent;
  const root = p ?? cmd;
  const colorOpt = (root.opts() as { color?: boolean }).color;
  return { color: colorOpt !== false };
}

// ─── validate ────────────────────────────────────────────────────────

export async function runValidate(path: string, opts: CommonOpts): Promise<number> {
  try {
    const bundle = await loadBundle(path);
    const courseMsg = bundle.course
      ? `course «${bundle.course.data.slug}»`
      : 'course (none)';
    const lessonsMsg = `${bundle.lessons.length} lesson(s)`;
    process.stdout.write(
      paint(opts, 'green', `✓ valid: ${courseMsg}, ${lessonsMsg}\n`),
    );
    return 0;
  } catch (e) {
    handleError(e, opts);
    return 1;
  }
}

// ─── dry-run ─────────────────────────────────────────────────────────

export async function runDryRun(
  path: string,
  baseUrl: string,
  token: string | undefined,
  opts: CommonOpts,
): Promise<number> {
  try {
    const bundle = await loadBundle(path);
    const client = new AdminApiClient({ baseUrl, token });
    const courseSlug = bundle.course?.data.slug ?? bundle.lessons[0]?.data.courseSlug;
    if (!courseSlug) {
      throw new Error('cannot determine course slug from bundle');
    }
    const snapshot = await client.getCourseBySlug(courseSlug).catch((e) => {
      // если курса нет — это create-сценарий; считаем snapshot=null.
      if (/404/.test(String(e))) return null;
      throw e;
    });
    const diff = diffBundle(bundle, snapshot);
    process.stdout.write(formatBundleDiff(diff, { useColor: opts.color !== false }) + '\n');
    return 0;
  } catch (e) {
    handleError(e, opts);
    return 1;
  }
}

// ─── import ──────────────────────────────────────────────────────────

export async function runImport(
  path: string,
  baseUrl: string,
  token: string | undefined,
  yes: boolean,
  opts: CommonOpts,
): Promise<number> {
  try {
    const bundle = await loadBundle(path);
    const client = new AdminApiClient({ baseUrl, token });
    const courseSlug = bundle.course?.data.slug ?? bundle.lessons[0]?.data.courseSlug;
    if (!courseSlug) throw new Error('cannot determine course slug from bundle');

    const snapshot = await client.getCourseBySlug(courseSlug).catch((e) => {
      if (/404/.test(String(e))) return null;
      throw e;
    });
    const diff = diffBundle(bundle, snapshot);
    process.stdout.write(formatBundleDiff(diff, { useColor: opts.color !== false }) + '\n');

    if (!yes) {
      process.stdout.write(
        paint(opts, 'yellow', '\nDry-run only (no --yes flag). Re-run with --yes to apply.\n'),
      );
      return 0;
    }
    const results = await upsertBundle(bundle, { baseUrl, token });
    let exitCode = 0;
    for (const r of results) {
      if (r.status === 'ok') {
        process.stdout.write(paint(opts, 'green', '✓ applied\n'));
      } else if (r.status === 'not_implemented') {
        process.stdout.write(
          paint(opts, 'yellow', `! ${r.message ?? 'endpoint not implemented'}\n`),
        );
        exitCode = 2;
      } else {
        process.stdout.write(
          paint(opts, 'red', `✗ ${r.message ?? 'unknown error'}\n`),
        );
        if (r.raw !== undefined) process.stdout.write(JSON.stringify(r.raw, null, 2) + '\n');
        exitCode = 1;
      }
    }
    return exitCode;
  } catch (e) {
    handleError(e, opts);
    return 1;
  }
}

// ─── export ──────────────────────────────────────────────────────────

export async function runExport(cmdOpts: {
  course: string;
  baseUrl: string;
  out: string;
  token?: string;
  dryRun?: boolean;
}): Promise<number> {
  try {
    const r = await exportCourse({
      baseUrl: cmdOpts.baseUrl,
      courseSlug: cmdOpts.course,
      outDir: cmdOpts.out,
      token: cmdOpts.token,
      dryRun: cmdOpts.dryRun,
    });
    process.stdout.write(`course.yml → ${r.courseFile.path}\n`);
    for (const l of r.lessonFiles) process.stdout.write(`lesson    → ${l.path}\n`);
    if (cmdOpts.dryRun) {
      process.stdout.write('(dry-run; no files written)\n');
    }
    return 0;
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
    return 1;
  }
}

// ─── общее ───────────────────────────────────────────────────────────

function handleError(e: unknown, opts: CommonOpts): void {
  if (e instanceof ValidationFailure) {
    const text = formatErrors(e.errors, opts.color !== false);
    process.stderr.write(text + '\n');
    process.stderr.write(
      paint(opts, 'red', `\n${e.errors.length} error(s); validation failed.\n`),
    );
    return;
  }
  process.stderr.write(paint(opts, 'red', '✗ ' + (e instanceof Error ? e.message : String(e)) + '\n'));
}

function paint(opts: CommonOpts, color: 'red' | 'green' | 'yellow', s: string): string {
  if (opts.color === false) return s;
  return pc[color](s);
}

// ─── entry-point ─────────────────────────────────────────────────────

// Позволяет импортировать buildProgram() из тестов без запуска CLI.
// argv[1] может быть симлинком (npm-bin); сравниваем по realpath.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const program = buildProgram();
  program
    .parseAsync(process.argv)
    .then(() => {
      // commander.action() ничего не возвращает; exit code мы сами выставляем
      // из обработчиков через process.exitCode.
    })
    .catch((e) => {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
