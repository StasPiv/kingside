/**
 * KS-2017 / B-1 — парсинг и валидация файлов курса/урока.
 *
 * Один файл = один объект (course или lesson). Директория = один
 * `course.yml` + N `*.lesson.yml`. AJV 8.x импортирует схемы из
 * `@kingside/lesson-schema` (B-2).
 *
 * Бизнес-валидация (FEN/PGN/UCI legal-check, видео-хост whitelist,
 * custom-puzzle решение) выполняется на admin-эндпоинте B-3 — здесь
 * только структурный AJV-слой (см. ADR §5.3).
 */

import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import { Ajv, type ValidateFunction } from 'ajv';
// ajv-formats CJS-default; в ESM приходит namespace c .default. Учитываем оба.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as addFormatsNS from 'ajv-formats';
const addFormats: (ajv: Ajv) => Ajv =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (addFormatsNS as any).default ?? (addFormatsNS as any);
import { courseSchema, lessonSchema } from '@kingside/lesson-schema';
import { describeAjvErrors } from './errors.js';
import type {
  CourseFileData,
  DescribedError,
  LessonFileData,
  ParsedBundle,
  ParsedCourseFile,
  ParsedLessonFile,
} from './types.js';

/**
 * Лениво создаём AJV-валидаторы (один раз на процесс). `strict:false`
 * — чтобы AJV 8 не падал на наших custom keywords (`description`,
 * `additionalProperties:false` поверх $defs и т. п.).
 */
let cached: { course: ValidateFunction; lesson: ValidateFunction } | null = null;
function getValidators() {
  if (cached) return cached;
  const ajv = new Ajv({ allErrors: true, strict: false });
  // ajv-formats: «uuid», «uri» и т. п. (uuid — для game_review.gameId).
  addFormats(ajv);
  cached = {
    course: ajv.compile(courseSchema),
    lesson: ajv.compile(lessonSchema),
  };
  return cached;
}

export class ValidationFailure extends Error {
  readonly errors: DescribedError[];
  constructor(errors: DescribedError[]) {
    super(`${errors.length} validation error(s)`);
    this.name = 'ValidationFailure';
    this.errors = errors;
  }
}

export function parseCourseYaml(absPath: string, raw: string): ParsedCourseFile {
  const data = parseYamlOrThrow(absPath, raw);
  const { course } = getValidators();
  if (!course(data)) {
    throw new ValidationFailure(describeAjvErrors(absPath, data, course.errors));
  }
  return { path: absPath, data: data as CourseFileData };
}

export function parseLessonYaml(absPath: string, raw: string): ParsedLessonFile {
  const data = parseYamlOrThrow(absPath, raw);
  const { lesson } = getValidators();
  if (!lesson(data)) {
    throw new ValidationFailure(describeAjvErrors(absPath, data, lesson.errors));
  }
  return { path: absPath, data: data as LessonFileData };
}

function parseYamlOrThrow(absPath: string, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { filename: absPath });
  } catch (e) {
    throw new ValidationFailure([
      {
        file: absPath,
        instancePath: '<root>',
        message: e instanceof Error ? e.message : String(e),
        keyword: 'yaml-syntax',
      },
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationFailure([
      {
        file: absPath,
        instancePath: '<root>',
        message: 'YAML root must be a mapping (object)',
        keyword: 'yaml-shape',
      },
    ]);
  }
  return parsed;
}

/**
 * Прочитать один файл или директорию и вернуть курс + уроки.
 *
 * Эвристика:
 *  - вход — файл `*.lesson.yml` или `*.lesson.yaml` → один урок без курса.
 *  - вход — файл `course.yml` / `course.yaml` → только курс, без уроков.
 *  - вход — директория → ищем `course.yml(.yaml)` и `*.lesson.yml(.yaml)`.
 */
export async function loadBundle(inputPath: string): Promise<ParsedBundle> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
  let s;
  try {
    s = await stat(abs);
  } catch (e) {
    throw new ValidationFailure([
      {
        file: abs,
        instancePath: '<root>',
        message: `cannot read path: ${e instanceof Error ? e.message : String(e)}`,
        keyword: 'fs',
      },
    ]);
  }

  if (s.isFile()) {
    const name = basename(abs);
    const raw = readFileSync(abs, 'utf8');
    if (isCourseFileName(name)) {
      return { course: parseCourseYaml(abs, raw), lessons: [] };
    }
    if (isLessonFileName(name)) {
      return { lessons: [parseLessonYaml(abs, raw)] };
    }
    throw new ValidationFailure([
      {
        file: abs,
        instancePath: '<root>',
        message: `unrecognized file name: expected course.yml / *.lesson.yml`,
        keyword: 'fs',
      },
    ]);
  }

  if (s.isDirectory()) {
    const entries = await readdir(abs);
    const errs: DescribedError[] = [];
    let course: ParsedCourseFile | undefined;
    const lessons: ParsedLessonFile[] = [];
    for (const name of entries.sort()) {
      const p = join(abs, name);
      let entryStat;
      try {
        entryStat = await stat(p);
      } catch {
        continue;
      }
      if (!entryStat.isFile()) continue;
      if (!isYamlFileName(name)) continue;
      const raw = readFileSync(p, 'utf8');
      try {
        if (isCourseFileName(name)) {
          if (course) {
            errs.push({
              file: p,
              instancePath: '<root>',
              message: `duplicate course file (already saw ${course.path})`,
              keyword: 'fs',
            });
          } else {
            course = parseCourseYaml(p, raw);
          }
        } else if (isLessonFileName(name)) {
          lessons.push(parseLessonYaml(p, raw));
        }
      } catch (e) {
        if (e instanceof ValidationFailure) errs.push(...e.errors);
        else throw e;
      }
    }
    if (errs.length) throw new ValidationFailure(errs);
    return { course, lessons };
  }

  throw new ValidationFailure([
    {
      file: abs,
      instancePath: '<root>',
      message: 'path is not a file or directory',
      keyword: 'fs',
    },
  ]);
}

export function isCourseFileName(name: string): boolean {
  return name === 'course.yml' || name === 'course.yaml';
}

export function isLessonFileName(name: string): boolean {
  return /\.lesson\.ya?ml$/.test(name);
}

export function isYamlFileName(name: string): boolean {
  return /\.ya?ml$/.test(name);
}
