#!/usr/bin/env node
/**
 * KS-2045 Этап 1 — CLI конвертера PDF → YAML lesson-format.
 *
 * Полный пайплайн (config-mode):
 *
 *   pdf-to-lesson-yaml <input.pdf> --config <converter.yml>
 *                       --output <dir> [--overwrite]
 *
 * Ad-hoc режим (одна глава по диапазону страниц):
 *
 *   pdf-to-lesson-yaml <input.pdf> --page-range 14-22
 *                       --slug ch1-game-pieces-moves-goal
 *                       --course-slug capablanca-primer
 *                       --output <dir>
 *
 * В обоих режимах: AST → text-шаги + диаграммы → YAML, AJV-валидация
 * перед записью. Если валидация падает — файл записывается, но в stderr
 * пишется отчёт с проблемами (Stage 1 — draft-режим).
 *
 * Доп. опции:
 *   --emit-ast <path>   — сохранить промежуточный AST в JSON (для отладки).
 *   --python <path>     — путь к Python (default: python3).
 */

import { realpathSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve, join, basename } from 'node:path';
import yaml from 'js-yaml';
import { extractPdf } from './extractor.js';
import { buildLesson } from './transformer.js';
import { serializeLesson, serializeCourse } from './yaml-serializer.js';
import { validateLesson, validateCourse } from './validator.js';
import type {
  ConverterChapterConfig,
  ConverterConfig,
  YamlCourseFile,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CliArgs {
  pdfPath: string;
  configPath?: string;
  output: string;
  pageRange?: [number, number];
  slug?: string;
  courseSlug?: string;
  overwrite: boolean;
  emitAst?: string;
  pythonPath: string;
}

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Usage: pdf-to-lesson-yaml <input.pdf> [options]',
      '',
      'Options:',
      '  --config <path>          путь к converter-config.yml',
      '  --output <dir>           каталог для записи course.yml + *.lesson.yml (обязательно)',
      '  --page-range A-B         ad-hoc-режим: одна глава по этим страницам (1-indexed inclusive)',
      '  --slug <slug>            ad-hoc: lesson.slug',
      '  --course-slug <slug>     ad-hoc: course.slug',
      '  --overwrite              перезаписать существующие файлы (по умолчанию — fail)',
      '  --emit-ast <path>        сохранить промежуточный AST в JSON',
      '  --python <path>          путь к интерпретатору python3 (по умолчанию python3)',
      '  -h, --help               справка',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { overwrite: false, pythonPath: 'python3' };
  let positional: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printUsage(process.stdout);
      process.exit(0);
    }
    if (a === '--config') {
      out.configPath = argv[++i];
      continue;
    }
    if (a === '--output') {
      out.output = argv[++i];
      continue;
    }
    if (a === '--page-range') {
      const v = argv[++i];
      const m = /^(\d+)-(\d+)$/.exec(v ?? '');
      if (!m) {
        process.stderr.write(`error: --page-range expects "A-B" (got "${v}")\n`);
        process.exit(2);
      }
      out.pageRange = [Number(m[1]), Number(m[2])];
      continue;
    }
    if (a === '--slug') {
      out.slug = argv[++i];
      continue;
    }
    if (a === '--course-slug') {
      out.courseSlug = argv[++i];
      continue;
    }
    if (a === '--overwrite') {
      out.overwrite = true;
      continue;
    }
    if (a === '--emit-ast') {
      out.emitAst = argv[++i];
      continue;
    }
    if (a === '--python') {
      out.pythonPath = argv[++i];
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`error: unknown option: ${a}\n`);
      printUsage(process.stderr);
      process.exit(2);
    }
    if (positional !== null) {
      process.stderr.write('error: too many positional arguments\n');
      process.exit(2);
    }
    positional = a;
  }
  if (!positional) {
    process.stderr.write('error: missing input PDF path\n');
    printUsage(process.stderr);
    process.exit(2);
  }
  if (!out.output) {
    process.stderr.write('error: --output is required\n');
    process.exit(2);
  }
  if (!out.configPath && !out.pageRange) {
    process.stderr.write('error: provide either --config OR --page-range\n');
    process.exit(2);
  }
  if (out.pageRange && (!out.slug || !out.courseSlug)) {
    process.stderr.write('error: ad-hoc mode (--page-range) requires --slug and --course-slug\n');
    process.exit(2);
  }
  return {
    pdfPath: positional,
    configPath: out.configPath,
    output: out.output!,
    pageRange: out.pageRange,
    slug: out.slug,
    courseSlug: out.courseSlug,
    overwrite: out.overwrite!,
    emitAst: out.emitAst,
    pythonPath: out.pythonPath!,
  };
}

function loadConfig(absPath: string): ConverterConfig {
  const raw = readFileSync(absPath, 'utf8');
  const data = yaml.load(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${absPath}: expected a YAML mapping at root`);
  }
  // Лёгкая валидация: course и chapters обязательны.
  const cfg = data as ConverterConfig;
  if (!cfg.course?.slug) {
    throw new Error(`${absPath}: missing course.slug`);
  }
  if (!Array.isArray(cfg.chapters) || cfg.chapters.length === 0) {
    throw new Error(`${absPath}: chapters[] is empty or missing`);
  }
  return cfg;
}

function configToCourseYaml(cfg: ConverterConfig): YamlCourseFile {
  const c = cfg.course;
  return {
    schemaVersion: 1,
    slug: c.slug,
    level: c.level,
    isPublished: c.isPublished ?? false,
    titleKey: c.titleKey,
    descriptionKey: c.descriptionKey,
    audienceI18nKey: c.audienceI18nKey ?? null,
    hookI18nKey: c.hookI18nKey ?? null,
    outcomeI18nKey: c.outcomeI18nKey ?? null,
    title: c.title,
    description: c.description,
    difficulty: c.difficulty,
    estimatedMinutes: c.estimatedMinutes,
    tags: c.tags ?? [],
    blockOrder: c.blockOrder ?? [],
  };
}

function paddedOrder(n: number): string {
  return String(n + 1).padStart(2, '0');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeFileWithGuard(path: string, content: string, overwrite: boolean): void {
  if (existsSync(path) && !overwrite) {
    throw new Error(`refusing to overwrite ${path} (pass --overwrite)`);
  }
  writeFileSync(path, content, 'utf8');
}

function reportProblems(label: string, problems: { path: string; message: string }[]): void {
  if (problems.length === 0) {
    process.stderr.write(`✓ ${label}: schema OK\n`);
    return;
  }
  process.stderr.write(`! ${label}: ${problems.length} schema problem(s):\n`);
  for (const p of problems) {
    process.stderr.write(`  - ${p.path}: ${p.message}\n`);
  }
}

async function processChapter(
  pdfPath: string,
  chapter: ConverterChapterConfig,
  courseSlug: string,
  outputDir: string,
  overwrite: boolean,
  pythonPath: string,
  emitAstPath?: string,
): Promise<void> {
  const ast = await extractPdf(pdfPath, {
    pageStart: chapter.pageRange[0],
    pageEnd: chapter.pageRange[1],
    pythonPath,
  });
  if (emitAstPath) {
    writeFileSync(emitAstPath, JSON.stringify(ast, null, 2), 'utf8');
    process.stderr.write(`AST → ${emitAstPath}\n`);
  }
  const lesson = buildLesson(ast, chapter, courseSlug);
  const problems = validateLesson(lesson);
  reportProblems(`lesson ${chapter.slug}`, problems);

  const fileName = `${paddedOrder(chapter.order)}-${chapter.slug}.lesson.yml`;
  const outPath = join(outputDir, fileName);
  writeFileWithGuard(outPath, serializeLesson(lesson), overwrite);
  process.stdout.write(
    `${outPath}  (${lesson.steps.length} steps, ` +
      `${lesson.steps.reduce((sum, s) => sum + (s.diagrams?.length ?? 0), 0)} diagrams)\n`,
  );
}

async function runConfigMode(args: CliArgs): Promise<number> {
  const cfgPath = isAbsolute(args.configPath!) ? args.configPath! : resolve(args.configPath!);
  const cfg = loadConfig(cfgPath);

  ensureDir(args.output);

  // course.yml.
  const courseYaml = configToCourseYaml(cfg);
  const coursePath = join(args.output, 'course.yml');
  const courseProblems = validateCourse(courseYaml);
  reportProblems('course', courseProblems);
  writeFileWithGuard(coursePath, serializeCourse(courseYaml), args.overwrite);
  process.stdout.write(`${coursePath}\n`);

  for (const chapter of cfg.chapters) {
    await processChapter(
      args.pdfPath,
      chapter,
      cfg.course.slug,
      args.output,
      args.overwrite,
      args.pythonPath,
      undefined,
    );
  }
  return 0;
}

async function runAdHocMode(args: CliArgs): Promise<number> {
  const chapter: ConverterChapterConfig = {
    title: args.slug!,
    slug: args.slug!,
    pageRange: args.pageRange!,
    blockKey: 'imported',
    kind: 'theory',
    order: 0,
    titleKey: `lessons.${args.courseSlug}.${args.slug}.title`,
    summaryKey: `lessons.${args.courseSlug}.${args.slug}.summary`,
    isPublished: false,
  };
  ensureDir(args.output);
  await processChapter(
    args.pdfPath,
    chapter,
    args.courseSlug!,
    args.output,
    args.overwrite,
    args.pythonPath,
    args.emitAst,
  );
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.configPath) {
      return await runConfigMode(args);
    }
    return await runAdHocMode(args);
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then((code) => process.exit(code));
}

export { parseArgs, runConfigMode, runAdHocMode };
