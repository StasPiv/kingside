/**
 * KS-2017 / B-1 — diff между состоянием БД и YAML-файлом.
 *
 * Семантика upsert (см. ADR §5.2):
 *  - course.slug совпал → update только изменённых полей; нет → create.
 *  - lesson.slug совпал → update; нет → create.
 *  - steps: индексное соответствие (i-й в файле ↔ i-й в БД). Лишние
 *    шаги в БД (existing.length > new.length) удаляются. Не хватает
 *    (new > existing) — создаются. Если в позиции i разный type или
 *    payload — update.
 *
 * Идемпотентность: «no diff» означает что повторный import вернёт
 * `0 created, 0 updated, 0 deleted` и не сделает ни одного UPDATE.
 */

import type {
  BundleDiff,
  CourseFileData,
  DbCourseSnapshot,
  DbLessonSnapshot,
  DbStepSnapshot,
  LessonDiff,
  LessonFileData,
  LessonStepData,
  ParsedBundle,
  StepDiffEntry,
} from './types.js';

/**
 * Поля курса, которые мы сравниваем для определения «update». Список
 * соответствует тому, что отдаёт `GET /lessons/admin/courses/:id` (см.
 * apps/api/src/lessons/admin/lessons-admin.service.ts → mapCourse).
 *
 * Важно: i18n-ключи из публичного API приходят как `titleI18nKey`, но
 * админский CRUD оперирует `titleKey`. Здесь работаем в терминах файла
 * (titleKey), т. к. сравнение всегда делается с админским snapshot'ом.
 */
const COURSE_COMPARABLE_FIELDS: (keyof CourseFileData)[] = [
  'slug',
  'level',
  'order',
  'isPublished',
  'titleKey',
  'descriptionKey',
  'audienceI18nKey',
  'hookI18nKey',
  'outcomeI18nKey',
  'title',
  'description',
  'audience',
  'hook',
  'outcome',
  'coverUrl',
  'difficulty',
  'estimatedMinutes',
  'tags',
];

const LESSON_COMPARABLE_FIELDS: (keyof LessonFileData)[] = [
  'slug',
  'order',
  'blockKey',
  'kind',
  'isPublished',
  'titleKey',
  'summaryKey',
  'title',
  'summary',
  'estMinutes',
];

export function diffBundle(
  parsed: ParsedBundle,
  db: DbCourseSnapshot | null,
): BundleDiff {
  const courseDiff = parsed.course ? diffCourseMeta(parsed.course.data, db) : null;
  const lessons: LessonDiff[] = [];
  const dbLessonsBySlug = new Map<string, DbLessonSnapshot>();
  if (db) {
    for (const l of db.lessons) dbLessonsBySlug.set(l.slug, l);
  }
  for (const file of parsed.lessons) {
    const dbLesson = dbLessonsBySlug.get(file.data.slug) ?? null;
    lessons.push(diffLesson(file.data, dbLesson));
  }
  return { course: courseDiff, lessons };
}

export function diffCourseMeta(
  fileData: CourseFileData,
  db: DbCourseSnapshot | null,
): BundleDiff['course'] {
  if (!db) {
    return { slug: fileData.slug, action: 'create' };
  }
  const changed: string[] = [];
  for (const f of COURSE_COMPARABLE_FIELDS) {
    if (!(f in fileData)) continue; // поле не указано в YAML — не считаем разницей
    const fileVal = fileData[f];
    const dbVal = (db as unknown as Record<string, unknown>)[f];
    if (!deepEqual(fileVal, dbVal)) changed.push(f);
  }
  if (changed.length === 0) return { slug: fileData.slug, action: 'unchanged' };
  return { slug: fileData.slug, action: 'update', changedFields: changed };
}

export function diffLesson(
  fileData: LessonFileData,
  db: DbLessonSnapshot | null,
): LessonDiff {
  if (!db) {
    return {
      slug: fileData.slug,
      lessonAction: 'create',
      steps: fileData.steps.map((s, i) => ({
        order: i + 1,
        type: s.type,
        action: 'create',
      })),
    };
  }
  const changed: string[] = [];
  for (const f of LESSON_COMPARABLE_FIELDS) {
    if (!(f in fileData)) continue;
    const fileVal = fileData[f];
    const dbVal = (db as unknown as Record<string, unknown>)[f];
    if (!deepEqual(fileVal, dbVal)) changed.push(f);
  }
  const lessonAction: 'update' | 'unchanged' = changed.length === 0 ? 'unchanged' : 'update';
  const steps = diffSteps(fileData.steps, db.steps);
  return {
    slug: fileData.slug,
    lessonAction,
    changedLessonFields: lessonAction === 'update' ? changed : undefined,
    steps,
  };
}

export function diffSteps(
  fileSteps: LessonStepData[],
  dbSteps: DbStepSnapshot[],
): StepDiffEntry[] {
  const out: StepDiffEntry[] = [];
  // Сравниваем по индексу.
  const max = Math.max(fileSteps.length, dbSteps.length);
  for (let i = 0; i < max; i++) {
    const incoming = fileSteps[i];
    const existing = dbSteps[i];
    if (incoming && !existing) {
      out.push({ order: i + 1, type: incoming.type, action: 'create' });
      continue;
    }
    if (!incoming && existing) {
      out.push({
        order: existing.order,
        type: existing.type,
        action: 'delete',
      });
      continue;
    }
    if (!incoming || !existing) continue;
    const samePayload = deepEqualPayload(stripDiscriminator(incoming), {
      type: existing.type,
      ...existing.payload,
    });
    const sameType = incoming.type === existing.type;
    const sameOrder = existing.order === i + 1;
    if (sameType && samePayload && sameOrder) {
      out.push({ order: i + 1, type: incoming.type, action: 'unchanged' });
    } else {
      const reasons: string[] = [];
      if (!sameType) reasons.push(`type: ${existing.type} → ${incoming.type}`);
      if (!sameOrder) reasons.push(`order: ${existing.order} → ${i + 1}`);
      if (!samePayload) reasons.push('payload changed');
      out.push({
        order: i + 1,
        type: incoming.type,
        action: 'update',
        details: reasons.join(', '),
      });
    }
  }
  return out;
}

/**
 * Глубокое сравнение JSON-объектов с нормализацией порядка ключей
 * (важно для сравнения JSONB.payload в Postgres). Массивы сравниваются
 * по индексу — порядок diagrams[0] / diagrams[1] значим. См. ADR §5.4.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(ao[aKeys[i]!], bo[bKeys[i]!])) return false;
  }
  return true;
}

export const deepEqualPayload = deepEqual;

/** Возвращает копию шага без поля `type` (используется в payload-сравнении). */
function stripDiscriminator(step: LessonStepData): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, ...rest } = step;
  return { type, ...rest };
}
