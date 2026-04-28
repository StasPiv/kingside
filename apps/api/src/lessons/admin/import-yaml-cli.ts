#!/usr/bin/env node
/**
 * CLI: импорт одного `*.lesson.yml` напрямую через `LessonsAdminImportService`,
 * без HTTP и без admin-токена.
 *
 * Один сервис (`LessonsAdminImportService`) — два потребителя:
 *   - HTTP: `POST /api/lessons/admin/import` (контроллер
 *     `LessonsAdminImportController`, под `JwtAuthGuard + AdminEmailGuard`);
 *   - локальная консоль: эта команда — поднимает Nest standalone-context,
 *     достаёт сервис из DI, вызывает `importLesson(dto)`.
 *
 * Запуск:
 *
 *   npm --workspace=@kingside/api run import:lesson -- <path/to/lesson.yml> \
 *       [--course path/to/course.yml] [--dry-run]
 *
 * Pipeline 1:1 с HTTP-вариантом:
 *   1. yaml.load(file) → plain object (lesson; опционально course).
 *   2. plainToInstance(ImportRequestDto, …) — class-transformer строит
 *      дискриминированный union по `step.type`.
 *   3. validate(dto, { whitelist: true }) — те же декораторы, что в
 *      ValidationPipe (`@IsFen`, `@ArePositionMovesLegal`, …).
 *   4. service.importLesson(dto) — atomic prisma.$transaction с
 *      upsert/sync/cleanup.
 *
 * Exit-code: 0 — успех, 1 — ошибка (валидация / БД / I/O), 2 — кривые
 * аргументы CLI.
 */

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger, ValidationError } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import yaml from 'js-yaml';
import { AppModule } from '../../app.module';
import { LessonsAdminImportService } from './lessons-admin-import.service';
import { ImportRequestDto } from './dto/import-lesson.dto';

interface CliArgs {
  lessonPath: string;
  coursePath?: string;
  dryRun: boolean;
  /** KS-2095: язык контента (ru|en). Передаётся в course.lang. */
  lang?: 'ru' | 'en';
  /** KS-2095: slug курса-родителя на другом языке (опц.). */
  parent?: string;
}

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Usage: import-yaml-cli <lesson.yml> [--course <course.yml>]',
      '       [--lang ru|en] [--parent <slug>] [--dry-run]',
      '',
      'Импортирует один lesson.yml в БД через LessonsAdminImportService',
      '(тот же путь, что HTTP /api/lessons/admin/import — но без авторизации,',
      'локально через Nest standalone-context).',
      '',
      'Options:',
      '  --course <path>   опциональный course.yml — upsert метаданных курса',
      '  --lang <code>     язык контента ru|en (default: значение из course.yml,',
      '                    иначе ru). Передаётся как course.lang.',
      '  --parent <slug>   slug курса-родителя на другом языке. Используется',
      '                    при --lang en для связи с русским вариантом.',
      '                    Если не задан — импортёр находит parent сам по',
      '                    тому же slug.',
      '  --dry-run         выполнить и откатить транзакцию, вернуть diff',
      '  -h, --help        показать эту справку',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { dryRun: false };
  let positional: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printUsage(process.stdout);
      process.exit(0);
    }
    if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === '--course') {
      out.coursePath = argv[++i];
      if (!out.coursePath) {
        process.stderr.write('error: --course requires a path argument\n');
        process.exit(2);
      }
      continue;
    }
    if (a === '--lang') {
      const v = argv[++i];
      if (v !== 'ru' && v !== 'en') {
        process.stderr.write('error: --lang requires "ru" or "en"\n');
        process.exit(2);
      }
      out.lang = v;
      continue;
    }
    if (a === '--parent') {
      out.parent = argv[++i];
      if (!out.parent) {
        process.stderr.write('error: --parent requires a slug argument\n');
        process.exit(2);
      }
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`error: unknown option: ${a}\n`);
      printUsage(process.stderr);
      process.exit(2);
    }
    if (positional !== null) {
      process.stderr.write('error: too many positional arguments\n');
      printUsage(process.stderr);
      process.exit(2);
    }
    positional = a;
  }
  if (!positional) {
    process.stderr.write('error: missing lesson.yml path\n');
    printUsage(process.stderr);
    process.exit(2);
  }
  return {
    lessonPath: positional,
    coursePath: out.coursePath,
    dryRun: out.dryRun!,
    lang: out.lang,
    parent: out.parent,
  };
}

function loadYamlObject(absPath: string): Record<string, unknown> {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${absPath}: expected a YAML mapping at root`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Линейно сплющивает дерево `ValidationError` в человекочитаемые строки.
 * Зеркалит формат, который Nest ValidationPipe отдаёт в HTTP 400.
 */
function flattenErrors(errors: ValidationError[], parentPath = ''): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const path = parentPath ? `${parentPath}.${e.property}` : e.property;
    if (e.constraints) {
      for (const msg of Object.values(e.constraints)) {
        out.push(`${path}: ${msg}`);
      }
    }
    if (e.children && e.children.length > 0) {
      out.push(...flattenErrors(e.children, path));
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 1. YAML → plain object.
  const lessonAbs = resolve(args.lessonPath);
  let lessonRaw: Record<string, unknown>;
  let courseRaw: Record<string, unknown> | undefined;
  try {
    lessonRaw = loadYamlObject(lessonAbs);
    if (args.coursePath) {
      courseRaw = loadYamlObject(resolve(args.coursePath));
    }
  } catch (e) {
    process.stderr.write(`✗ failed to load YAML: ${(e as Error).message}\n`);
    return 1;
  }

  // KS-2095: CLI-флаги `--lang` / `--parent` переопределяют значения из
  // course.yml. Без course.yml эти флаги без эффекта (course-payload
  // вообще не передаётся в DTO; для существующего курса language уже
  // выставлен). При наличии course.yml — флаги впрыскиваются в payload.
  if (courseRaw) {
    if (args.lang !== undefined) courseRaw.lang = args.lang;
    if (args.parent !== undefined) courseRaw.parentSlug = args.parent;
  } else if (args.lang !== undefined || args.parent !== undefined) {
    process.stderr.write(
      'error: --lang/--parent require --course <course.yml> (нужно создать/обновить курс с этими параметрами)\n',
    );
    return 2;
  }

  // 2. plain → DTO (class-transformer строит дискриминированный union по step.type).
  const dto = plainToInstance(
    ImportRequestDto,
    { course: courseRaw, lesson: lessonRaw, dryRun: args.dryRun },
    { enableImplicitConversion: false },
  );

  // 3. class-validator: те же декораторы, что у HTTP-пайплайна
  //    (`@IsFen`, `@ArePositionMovesLegal`, …). whitelist=true дублирует
  //    `useGlobalPipes(new ValidationPipe({ whitelist: true }))`.
  const errors = await validate(dto, { whitelist: true });
  if (errors.length > 0) {
    const flat = flattenErrors(errors);
    process.stderr.write(`✗ validation failed (${flat.length} error(s)):\n`);
    for (const line of flat) process.stderr.write(`  - ${line}\n`);
    return 1;
  }

  // 4. Поднимаем Nest standalone-context, дёргаем сервис.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const service = app.get(LessonsAdminImportService, { strict: false });
    const result = await service.importLesson(dto);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (args.dryRun) {
      process.stderr.write('(dry-run; transaction was rolled back)\n');
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`✗ import failed: ${msg}\n`);
    if (e instanceof Error && e.stack) {
      process.stderr.write(e.stack + '\n');
    }
    return 1;
  } finally {
    await app.close();
  }
}

// Подавляем шумные Nest-логи на старте (нам нужен только результат и ошибки).
Logger.overrideLogger(['error', 'warn']);

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`✗ unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
