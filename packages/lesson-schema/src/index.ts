/**
 * @kingside/lesson-schema — JSON Schemas формата уроков (KS-2015 / B-2).
 *
 * Что отсюда экспортируется:
 *  - `courseSchema`  — схема файла `course.yml`.
 *  - `lessonSchema`  — схема файла `<slug>.lesson.yml` (8 типов шагов).
 *  - `SCHEMA_VERSION` — текущая версия формата (`schemaVersion` в файле).
 *
 * Импортёр (B-1, `tools/lesson-import`) и admin-эндпоинт (B-3,
 * `apps/api/src/lessons/admin`) реиспользуют эти JSON-объекты через AJV.
 *
 * Бизнес-валидация (FEN/PGN/UCI-легальность, видео-хост whitelist, custom
 * puzzle решение) выполняется DTO-декораторами на бэке — см. ADR §5.3.
 * Схема описывает только структуру, чтобы было где упасть на 400-ом
 * до payload'а транзакции.
 */

import courseSchema from '../schemas/course.schema.json';
import lessonSchema from '../schemas/lesson.schema.json';

export { courseSchema, lessonSchema };

/** Текущая версия формата (используется в `schemaVersion` каждого файла). */
export const SCHEMA_VERSION = 1 as const;

/**
 * Имена корневых схем (для AJV `addSchema` / `getSchema`, если impl
 * хочет резолвить через `$id`).
 */
export const COURSE_SCHEMA_ID = 'https://kingside.local/schemas/course.schema.json';
export const LESSON_SCHEMA_ID = 'https://kingside.local/schemas/lesson.schema.json';
