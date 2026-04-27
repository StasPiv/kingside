/**
 * KS-2017 / B-1 — экспорт курса из БД в YAML-файлы (`course.yml` +
 * `<NN>-<slug>.lesson.yml`). Используется в B-4 (KS-2019) для миграции
 * существующих курсов в `content/courses/`.
 *
 * Состояние БД читается через AdminApiClient. Сериализация — `js-yaml`
 * с `lineWidth: -1` (не переносим длинные строки), `noRefs: true` (не
 * генерируем `&anchor` / `*ref`), `quotingType: '` (одинарные кавычки).
 *
 * Маппинг полей (БД admin shape → файл):
 *  - `Course.titleI18nKey` (публичный) ↔ `Course.titleKey` (admin DTO).
 *    AdminApiClient возвращает то, что отдаёт admin endpoint, поэтому
 *    зеркальные имена сохраняются.
 *  - `Lesson.titleI18nKey` ↔ `Lesson.titleKey`. Аналогично.
 *  - `LessonStep.payload` копируется as-is с дискриминатором `type`.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { AdminApiClient } from './api-client.js';
import type {
  CourseFileData,
  DbCourseSnapshot,
  DbLessonSnapshot,
  LessonFileData,
  LessonStepData,
} from './types.js';

export interface ExportOptions {
  baseUrl: string;
  token?: string;
  /** Slug курса для экспорта. */
  courseSlug: string;
  /** Куда положить файлы. Создаётся автоматически. */
  outDir: string;
  /** dry-run — не пишем файлы, только возвращаем содержимое. */
  dryRun?: boolean;
}

export interface ExportResult {
  courseFile: { path: string; content: string };
  lessonFiles: Array<{ path: string; content: string }>;
}

export async function exportCourse(opts: ExportOptions): Promise<ExportResult> {
  const client = new AdminApiClient({ baseUrl: opts.baseUrl, token: opts.token });
  const snapshot = await client.getCourseBySlug(opts.courseSlug);
  if (!snapshot) {
    throw new Error(`course not found by slug=${opts.courseSlug}`);
  }
  const outDirAbs = resolve(opts.outDir);
  const courseFile = {
    path: join(outDirAbs, 'course.yml'),
    content: serializeCourse(courseFromSnapshot(snapshot)),
  };
  const lessonFiles: Array<{ path: string; content: string }> = [];
  for (const l of snapshot.lessons) {
    const data = lessonFromSnapshot(snapshot.slug, l);
    // Префикс файла — 1-based, для естественной сортировки (ADR §4.1).
    // `lesson.order` в БД 0-based, поэтому в файле имени добавляем +1.
    const fileName = `${prefixOrder(data.order + 1)}-${data.slug}.lesson.yml`;
    lessonFiles.push({
      path: join(outDirAbs, fileName),
      content: serializeLesson(data),
    });
  }

  if (!opts.dryRun) {
    if (!existsSync(outDirAbs)) mkdirSync(outDirAbs, { recursive: true });
    writeFileSync(courseFile.path, courseFile.content, 'utf8');
    for (const lf of lessonFiles) writeFileSync(lf.path, lf.content, 'utf8');
  }

  return { courseFile, lessonFiles };
}

function prefixOrder(order: number): string {
  return order.toString().padStart(2, '0');
}

/** Перевод admin-snapshot курса в формат файла. */
export function courseFromSnapshot(snapshot: DbCourseSnapshot): CourseFileData {
  const s = snapshot as unknown as Record<string, unknown>;
  return removeUndefinedAndNullKeys<CourseFileData>({
    schemaVersion: 1,
    slug: snapshot.slug,
    level: (s.level as CourseFileData['level']) ?? 'beginner',
    order: s.order as number | undefined,
    isPublished: s.isPublished as boolean | undefined,
    titleKey: pickKey(s, ['titleKey', 'titleI18nKey']) ?? '',
    descriptionKey: pickKey(s, ['descriptionKey', 'descriptionI18nKey']) ?? '',
    audienceI18nKey: pickKey(s, ['audienceI18nKey']) ?? null,
    hookI18nKey: pickKey(s, ['hookI18nKey']) ?? null,
    outcomeI18nKey: pickKey(s, ['outcomeI18nKey']) ?? null,
    title: (s.title as string | null | undefined) ?? null,
    description: (s.description as string | null | undefined) ?? null,
    audience: (s.audience as string | null | undefined) ?? null,
    hook: (s.hook as string | null | undefined) ?? null,
    outcome: (s.outcome as string | null | undefined) ?? null,
    coverUrl: (s.coverUrl as string | null | undefined) ?? null,
    difficulty: s.difficulty as 1 | 2 | 3 | undefined,
    estimatedMinutes: (s.estimatedMinutes as number | null | undefined) ?? null,
    tags: (s.tags as string[] | undefined) ?? [],
  });
}

export function lessonFromSnapshot(
  courseSlug: string,
  snapshot: DbLessonSnapshot,
): LessonFileData {
  const s = snapshot as unknown as Record<string, unknown>;
  return removeUndefinedAndNullKeys<LessonFileData>({
    schemaVersion: 1,
    courseSlug,
    slug: snapshot.slug,
    order: snapshot.order,
    blockKey: (s.blockKey as string | undefined) ?? '',
    kind: (s.kind as LessonFileData['kind']) ?? 'theory',
    isPublished: s.isPublished as boolean | undefined,
    titleKey: pickKey(s, ['titleKey', 'titleI18nKey']) ?? '',
    summaryKey: pickKey(s, ['summaryKey', 'summaryI18nKey']) ?? '',
    title: (s.title as string | null | undefined) ?? null,
    summary: (s.summary as string | null | undefined) ?? null,
    estMinutes: s.estMinutes as number | undefined,
    steps: snapshot.steps.map((st) => ({
      type: st.type,
      ...st.payload,
    })) as LessonStepData[],
  });
}

function pickKey(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function removeUndefinedAndNullKeys<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && k === 'tags') continue;
    out[k] = v;
  }
  return out as T;
}

export function serializeCourse(data: CourseFileData): string {
  return yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    sortKeys: false,
  });
}

export function serializeLesson(data: LessonFileData): string {
  return yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    sortKeys: false,
  });
}
