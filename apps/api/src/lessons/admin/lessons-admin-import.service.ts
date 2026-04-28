import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ImportCoursePayloadDto,
  ImportLessonPayloadDto,
  ImportRequestDto,
  ImportResponse,
  StepImportDiff,
} from './dto/import-lesson.dto';

/**
 * KS-2018 / B-3 — атомарный импорт курса/урока из YAML-файла
 * (см. ADR `KS-2015-lesson-file-format.md` §5.2).
 *
 * Семантика:
 *  - `course` (опционально) — upsert по `slug`. Если курс не передан,
 *    но урок ссылается на не существующий `courseSlug`, бросаем 404.
 *  - `lesson` — upsert по `(courseId, slug)`.
 *  - `steps[]` — индексное сопоставление с существующими шагами
 *    (`existing[i]` ↔ `incoming[i]`):
 *      * совпало по type/payload/order → unchanged (UPDATE не делается);
 *      * разница → UPDATE с тем же `id` (важно: id шага НЕ меняется,
 *        чтобы прогресс пользователей в `UserLessonProgress.stepsState`
 *        не «слетел»);
 *      * `existing.length > incoming.length` → DELETE лишних старых;
 *      * `incoming.length > existing.length` → CREATE недостающих.
 *  - `UserLessonProgress.stepsState` чистится только от ID **удалённых**
 *    шагов (UPDATE не меняет id, так что чистка для них не нужна).
 *  - Всё внутри одной `prisma.$transaction`. При ошибке транзакция
 *    откатывается, БД остаётся прежней.
 *  - `dryRun=true` — бросаем синтетическую ошибку в конце транзакции,
 *    чтобы откатить, и возвращаем посчитанный diff.
 *
 * Этот сервис **не дублирует** валидацию payload'а — она выполняется
 * class-validator-декораторами на уровне DTO (`@IsFen`, `@IsValidPgn`,
 * `@ArePositionMovesLegal`, `@IsCustomPuzzlesArray`, `@IsVideoUrl` и
 * т. д. из `apps/api/src/lessons/dto/`).
 */
@Injectable()
export class LessonsAdminImportService {
  private readonly logger = new Logger(LessonsAdminImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async importLesson(dto: ImportRequestDto): Promise<ImportResponse> {
    const { course, lesson, dryRun = false } = dto;

    if (course && course.slug !== lesson.courseSlug) {
      throw new ConflictException(
        `course.slug (${course.slug}) does not match lesson.courseSlug (${lesson.courseSlug})`,
      );
    }

    // KS-2095: lang курса. Default 'ru' для обратной совместимости.
    const lang: 'ru' | 'en' = course?.lang ?? 'ru';

    const ROLLBACK_TOKEN = '__import_dry_run_rollback__';

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Course upsert (если передан) или lookup.
        const courseRow = await this.upsertCourse(
          tx,
          lesson.courseSlug,
          course,
          lang,
        );

        // 2. Lesson upsert (с резолвингом parentLessonId через root-курс).
        const lessonRow = await this.upsertLesson(
          tx,
          courseRow.id,
          courseRow.parentCourseId,
          lang,
          lesson,
        );

        // 3. Steps replace (с сохранением id).
        const diff = await this.syncSteps(tx, lessonRow.id, lesson.steps);

        // 4. Cleanup `UserLessonProgress.stepsState` от удалённых ID.
        const removedIds = diff.removed
          .map((d) => d.stepId)
          .filter((id): id is string => Boolean(id));
        if (removedIds.length > 0) {
          await this.cleanupStepsState(tx, lessonRow.id, removedIds);
        }

        const response: ImportResponse = {
          ok: true,
          course: {
            id: courseRow.id,
            slug: courseRow.slug,
            created: courseRow._meta.created,
            updated: courseRow._meta.updated,
          },
          lesson: {
            id: lessonRow.id,
            slug: lessonRow.slug,
            created: lessonRow._meta.created,
            updated: lessonRow._meta.updated,
          },
          diff,
          dryRun,
        };

        if (dryRun) {
          // Бросаем именованный rollback. Snуем результат в `.payload`,
          // чтобы во внешнем catch-блоке достать его обратно и не терять
          // diff (см. ADR §5.2 — dryRun возвращает diff и откатывается).
          throw new RollbackForDryRun(ROLLBACK_TOKEN, response);
        }

        return response;
      });
      return result;
    } catch (e) {
      if (e instanceof RollbackForDryRun && e.token === ROLLBACK_TOKEN) {
        return e.payload;
      }
      throw e;
    }
  }

  // ─── Course ──────────────────────────────────────────────────────

  private async upsertCourse(
    tx: Prisma.TransactionClient,
    slug: string,
    payload: ImportCoursePayloadDto | undefined,
    lang: 'ru' | 'en',
  ): Promise<{
    id: string;
    slug: string;
    parentCourseId: string | null;
    _meta: { created: boolean; updated: boolean };
  }> {
    // KS-2095: lookup курса в выбранном языке.
    const existing = await tx.course.findUnique({
      where: { slug_lang: { slug, lang } },
    });

    if (!existing) {
      if (!payload) {
        throw new NotFoundException(
          `Course "${slug}" (lang=${lang}) does not exist and no course payload was provided`,
        );
      }

      // KS-2095: для не-root языка резолвим parent. Логика:
      //   1) если в payload явно задан `parentSlug` — берём его (любой lang
      //      кроме текущего, root которого выйдет в parentCourseId);
      //   2) иначе ищем курс с тем же slug на другом языке (типичный
      //      сценарий: импортируем `course.yml` с тем же slug, lang=en, и
      //      хотим связать с уже существующим RU);
      //   3) если ничего не нашли и lang != 'ru' — это новый «root»-курс
      //      на не-русском языке; разрешаем (parentCourseId=null).
      let parentCourseId: string | null = null;
      if (lang !== 'ru') {
        const parentLookupSlug = payload.parentSlug ?? slug;
        const parents = await tx.course.findMany({
          where: { slug: parentLookupSlug, lang: { not: lang } },
        });
        // Выбираем root: parentCourseId IS NULL — это «канонический».
        const root = parents.find((p) => p.parentCourseId === null) ?? parents[0];
        if (root) {
          parentCourseId = root.id;
        } else if (payload.parentSlug) {
          // Пользователь явно попросил привязать к parentSlug, а его нет.
          throw new NotFoundException(
            `parent course "${payload.parentSlug}" (any lang ≠ ${lang}) not found`,
          );
        }
      }

      const order = payload.order ?? (await this.computeNextCourseOrder(tx));
      const created = await tx.course.create({
        data: {
          slug: payload.slug,
          lang,
          parentCourseId,
          level: payload.level,
          titleKey: payload.titleKey,
          descriptionKey: payload.descriptionKey,
          audienceI18nKey: payload.audienceI18nKey ?? null,
          hookI18nKey: payload.hookI18nKey ?? null,
          outcomeI18nKey: payload.outcomeI18nKey ?? null,
          title: payload.title ?? null,
          description: payload.description ?? null,
          audience: payload.audience ?? null,
          hook: payload.hook ?? null,
          outcome: payload.outcome ?? null,
          coverUrl: payload.coverUrl ?? null,
          difficulty: payload.difficulty ?? 2,
          estimatedMinutes: payload.estimatedMinutes ?? null,
          tags: payload.tags ?? [],
          // KS-2037: порядок блоков курса.
          blockOrder: payload.blockOrder ?? [],
          order,
          isPublished: payload.isPublished ?? false,
        },
      });
      return {
        id: created.id,
        slug: created.slug,
        parentCourseId: created.parentCourseId,
        _meta: { created: true, updated: false },
      };
    }

    if (!payload) {
      // Курс есть, новый payload не передан — ничего не делаем.
      return {
        id: existing.id,
        slug: existing.slug,
        parentCourseId: existing.parentCourseId,
        _meta: { created: false, updated: false },
      };
    }

    // Update только тех полей, что фактически отличаются.
    const data: Prisma.CourseUpdateInput = {};
    if (payload.level !== existing.level) data.level = payload.level;
    if (payload.titleKey !== existing.titleKey) data.titleKey = payload.titleKey;
    if (payload.descriptionKey !== existing.descriptionKey) {
      data.descriptionKey = payload.descriptionKey;
    }
    pickIfChanged(data, 'audienceI18nKey', payload.audienceI18nKey ?? null, existing.audienceI18nKey);
    pickIfChanged(data, 'hookI18nKey', payload.hookI18nKey ?? null, existing.hookI18nKey);
    pickIfChanged(data, 'outcomeI18nKey', payload.outcomeI18nKey ?? null, existing.outcomeI18nKey);
    pickIfChanged(data, 'title', payload.title ?? null, existing.title);
    pickIfChanged(data, 'description', payload.description ?? null, existing.description);
    pickIfChanged(data, 'audience', payload.audience ?? null, existing.audience);
    pickIfChanged(data, 'hook', payload.hook ?? null, existing.hook);
    pickIfChanged(data, 'outcome', payload.outcome ?? null, existing.outcome);
    pickIfChanged(data, 'coverUrl', payload.coverUrl ?? null, existing.coverUrl);
    if (payload.difficulty !== undefined && payload.difficulty !== existing.difficulty) {
      data.difficulty = payload.difficulty;
    }
    pickIfChanged(data, 'estimatedMinutes', payload.estimatedMinutes ?? null, existing.estimatedMinutes);
    if (payload.tags !== undefined && !arraysEqual(payload.tags, existing.tags)) {
      data.tags = payload.tags;
    }
    // KS-2037: порядок блоков курса. Передан в payload (даже как []) —
    // переписываем; не передан — не трогаем (пусть остаётся как было).
    if (
      payload.blockOrder !== undefined &&
      !arraysEqual(payload.blockOrder, existing.blockOrder)
    ) {
      data.blockOrder = payload.blockOrder;
    }
    if (payload.order !== undefined && payload.order !== existing.order) {
      data.order = payload.order;
    }
    if (payload.isPublished !== undefined && payload.isPublished !== existing.isPublished) {
      data.isPublished = payload.isPublished;
    }

    if (Object.keys(data).length === 0) {
      return {
        id: existing.id,
        slug: existing.slug,
        parentCourseId: existing.parentCourseId,
        _meta: { created: false, updated: false },
      };
    }

    const updated = await tx.course.update({ where: { id: existing.id }, data });
    return {
      id: updated.id,
      slug: updated.slug,
      parentCourseId: updated.parentCourseId,
      _meta: { created: false, updated: true },
    };
  }

  private async computeNextCourseOrder(tx: Prisma.TransactionClient): Promise<number> {
    const m = await tx.course.aggregate({ _max: { order: true } });
    return (m._max.order ?? -1) + 1;
  }

  // ─── Lesson ──────────────────────────────────────────────────────

  private async upsertLesson(
    tx: Prisma.TransactionClient,
    courseId: string,
    parentCourseId: string | null,
    lang: 'ru' | 'en',
    payload: ImportLessonPayloadDto,
  ): Promise<{ id: string; slug: string; _meta: { created: boolean; updated: boolean } }> {
    const existing = await tx.lesson.findUnique({
      where: { courseId_slug: { courseId, slug: payload.slug } },
    });

    if (!existing) {
      // KS-2095: для урока в не-root курсе — резолвим parentLessonId.
      // Канонический урок ищем в parent-курсе (parentCourseId) по тому же slug.
      let parentLessonId: string | null = null;
      if (parentCourseId !== null) {
        const parentLesson = await tx.lesson.findUnique({
          where: { courseId_slug: { courseId: parentCourseId, slug: payload.slug } },
          select: { id: true },
        });
        parentLessonId = parentLesson?.id ?? null;
        // Не throw'аем, если parent-урока нет: бывает, что англ. версия
        // содержит уроки, которых нет в RU (или порядок импорта не совпал).
        // В этом случае lesson становится «root» в EN-семье; прогресс
        // EN<->RU не сольётся, но система не падает.
      }

      const created = await tx.lesson.create({
        data: {
          courseId,
          slug: payload.slug,
          lang,
          parentLessonId,
          blockKey: payload.blockKey,
          kind: payload.kind,
          titleKey: payload.titleKey,
          summaryKey: payload.summaryKey,
          title: payload.title ?? null,
          summary: payload.summary ?? null,
          estMinutes: payload.estMinutes ?? 10,
          order: payload.order,
          isPublished: payload.isPublished ?? false,
        },
      });
      return { id: created.id, slug: created.slug, _meta: { created: true, updated: false } };
    }

    const data: Prisma.LessonUpdateInput = {};
    if (payload.order !== existing.order) data.order = payload.order;
    if (payload.blockKey !== existing.blockKey) data.blockKey = payload.blockKey;
    if (payload.kind !== existing.kind) data.kind = payload.kind;
    if (payload.titleKey !== existing.titleKey) data.titleKey = payload.titleKey;
    if (payload.summaryKey !== existing.summaryKey) data.summaryKey = payload.summaryKey;
    pickIfChanged(data, 'title', payload.title ?? null, existing.title);
    pickIfChanged(data, 'summary', payload.summary ?? null, existing.summary);
    if (payload.estMinutes !== undefined && payload.estMinutes !== existing.estMinutes) {
      data.estMinutes = payload.estMinutes;
    }
    if (payload.isPublished !== undefined && payload.isPublished !== existing.isPublished) {
      data.isPublished = payload.isPublished;
    }

    if (Object.keys(data).length === 0) {
      return {
        id: existing.id,
        slug: existing.slug,
        _meta: { created: false, updated: false },
      };
    }
    const updated = await tx.lesson.update({ where: { id: existing.id }, data });
    return {
      id: updated.id,
      slug: updated.slug,
      _meta: { created: false, updated: true },
    };
  }

  // ─── Steps ────────────────────────────────────────────────────────

  private async syncSteps(
    tx: Prisma.TransactionClient,
    lessonId: string,
    incomingArr: ReadonlyArray<{ type: string }>,
  ): Promise<ImportResponse['diff']> {
    // Шаги приходят как discriminated union DTO; для записи в БД
    // обрабатываем как plain JSON (валидация была в DTO-слое выше).
    const incoming = incomingArr as ReadonlyArray<Record<string, unknown> & { type: string }>;
    const existing = await tx.lessonStep.findMany({
      where: { lessonId },
      orderBy: { order: 'asc' },
    });

    const added: StepImportDiff[] = [];
    const updated: StepImportDiff[] = [];
    const unchanged: StepImportDiff[] = [];
    const removed: StepImportDiff[] = [];

    const max = Math.max(existing.length, incoming.length);
    for (let i = 0; i < max; i++) {
      const ex = existing[i];
      const inc = incoming[i];
      const order = i + 1;

      if (inc && !ex) {
        const created = await tx.lessonStep.create({
          data: {
            lessonId,
            order,
            type: inc.type,
            payload: inc as unknown as Prisma.InputJsonValue,
          },
        });
        added.push({ order, type: inc.type, action: 'created', stepId: created.id });
        continue;
      }

      if (!inc && ex) {
        await tx.lessonStep.delete({ where: { id: ex.id } });
        removed.push({
          order: ex.order,
          type: ex.type,
          action: 'removed',
          stepId: ex.id,
        });
        continue;
      }

      if (!inc || !ex) continue;

      const samePayload = deepEqualJson(stripNothing(inc), normalizePayload(ex.payload, ex.type));
      const sameType = ex.type === inc.type;
      const sameOrder = ex.order === order;

      if (samePayload && sameType && sameOrder) {
        unchanged.push({ order, type: ex.type, action: 'unchanged', stepId: ex.id });
        continue;
      }

      const data: Prisma.LessonStepUpdateInput = {};
      if (!sameType) data.type = inc.type;
      if (!sameOrder) data.order = order;
      if (!samePayload) data.payload = inc as unknown as Prisma.InputJsonValue;

      const upd = await tx.lessonStep.update({
        where: { id: ex.id },
        data,
      });
      updated.push({ order, type: upd.type, action: 'updated', stepId: upd.id });
    }

    return { added, updated, removed, unchanged };
  }

  // ─── stepsState cleanup ──────────────────────────────────────────

  private async cleanupStepsState(
    tx: Prisma.TransactionClient,
    lessonId: string,
    removedStepIds: string[],
  ): Promise<void> {
    if (removedStepIds.length === 0) return;
    const progresses = await tx.userLessonProgress.findMany({
      where: { lessonId },
      select: { id: true, stepsState: true },
    });
    const removedSet = new Set(removedStepIds);
    for (const p of progresses) {
      const state = (p.stepsState ?? {}) as Record<string, unknown>;
      let mutated = false;
      const next: Record<string, unknown> = {};
      for (const [stepId, value] of Object.entries(state)) {
        if (removedSet.has(stepId)) {
          mutated = true;
          continue;
        }
        next[stepId] = value;
      }
      if (mutated) {
        await tx.userLessonProgress.update({
          where: { id: p.id },
          data: { stepsState: next as unknown as Prisma.InputJsonValue },
        });
      }
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function pickIfChanged<T extends Record<string, unknown>>(
  out: T,
  key: keyof T,
  next: unknown,
  current: unknown,
): void {
  if (!deepEqualJson(next, current)) {
    (out as Record<string, unknown>)[key as string] = next;
  }
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqualJson(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Рекурсивно убрать ключи со значением `undefined` (и пройти по массивам
 * и объектам). Нужно для корректной идемпотентности `syncSteps`:
 * `plainToInstance(...)` создаёт class-instance, у которого опциональные
 * поля DTO лежат как `undefined`-properties (`Object.keys()` их видит).
 * При записи через Prisma JSON-колонку эти `undefined`'ы исчезают
 * (JSON.stringify их пропускает), и в БД ключей просто нет. Сравнение
 * `inc` (class-instance с undefined) против `ex.payload` (plain JSON
 * без undefined-ключей) ловит расхождение в `Object.keys().length` и
 * помечает шаг как `updated`, хотя содержимое идентично.
 *
 * Эта функция приводит обе формы к одному виду (без undefined-ключей).
 */
function stripNothing<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripNothing(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripNothing(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Нормализуем payload из БД к виду, в котором он хранится: discriminator
 * `type` (он есть в DB-payload и в файле) + остальные поля. На текущем
 * моменте обе формы одинаковы — функция возвращает payload as-is с
 * принудительной подстановкой `type` (на случай, если в БД лежит
 * payload без явного дискриминатора — мы зеркалим его из колонки `type`).
 */
function normalizePayload(payload: unknown, type: string): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') {
    return { type };
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return { ...obj, type };
  }
  return obj;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
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
    if (!deepEqualJson(ao[aKeys[i]!], bo[bKeys[i]!])) return false;
  }
  return true;
}

class RollbackForDryRun extends Error {
  constructor(
    public readonly token: string,
    public readonly payload: ImportResponse,
  ) {
    super('dry-run rollback');
  }
}
