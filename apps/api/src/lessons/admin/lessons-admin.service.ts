import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateAdminCourseDto,
  ListAdminCoursesQueryDto,
  ReorderAdminCoursesDto,
  UpdateAdminCourseDto,
} from './dto/admin-course.dto';
import {
  CreateAdminLessonDto,
  ReorderAdminLessonsDto,
  UpdateAdminLessonDto,
} from './dto/admin-lesson.dto';
import {
  CreateAdminStepDto,
  ReorderAdminStepsDto,
  UpdateAdminStepDto,
} from './dto/admin-step.dto';
import { GameStepHydratorService } from '../dto/game-step.hydrator';

/**
 * KS-1962/B-5: сервис админ-CRUD для system courses.
 *
 * Здесь — только курсы. Уроки и шаги добавятся в B-6/B-7. Полное
 * объединение и доводка (idempotent reorder в транзакции, конфликты
 * slug → 409, каскадные правила) — в B-8 (по концепту B-5..B-7
 * собирают функциональность по сущностям, B-8 — общий рефакторинг).
 *
 * Возвращаемые объекты — Prisma-модели as-is (контроллер прокидывает
 * напрямую). DTO для клиента совпадает с публичным `Course` shape'ом
 * с включением всех inline-полей и i18n-ключей.
 */
@Injectable()
export class LessonsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gameStepHydrator: GameStepHydratorService,
  ) {}

  // ─── List ────────────────────────────────────────────────────────

  async listCourses(query: ListAdminCoursesQueryDto) {
    const where: Prisma.CourseWhereInput = {};
    if (query.level) where.level = query.level;
    if (typeof query.published === 'boolean') where.isPublished = query.published;

    return this.prisma.course.findMany({
      where,
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      include: { _count: { select: { lessons: true } } },
    });
  }

  // ─── Read one ────────────────────────────────────────────────────

  async getCourseById(id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        lessons: {
          orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
          include: { _count: { select: { steps: true } } },
        },
        _count: { select: { lessons: true } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  // ─── Create ──────────────────────────────────────────────────────

  async createCourse(dto: CreateAdminCourseDto) {
    // Если order не передан — ставим max(order)+1, чтобы новый курс
    // оказался в конце списка своего уровня. Это удобнее, чем
    // конкурировать за `order=0`.
    const order = dto.order ?? (await this.computeNextOrder());

    try {
      return await this.prisma.course.create({
        data: {
          slug: dto.slug,
          level: dto.level,
          titleKey: dto.titleKey,
          descriptionKey: dto.descriptionKey,
          audienceI18nKey: dto.audienceI18nKey ?? null,
          hookI18nKey: dto.hookI18nKey ?? null,
          outcomeI18nKey: dto.outcomeI18nKey ?? null,
          title: dto.title ?? null,
          description: dto.description ?? null,
          audience: dto.audience ?? null,
          hook: dto.hook ?? null,
          outcome: dto.outcome ?? null,
          coverUrl: dto.coverUrl ?? null,
          difficulty: dto.difficulty ?? 2,
          estimatedMinutes: dto.estimatedMinutes ?? null,
          tags: dto.tags ?? [],
          order,
          isPublished: dto.isPublished ?? false,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(`Slug "${dto.slug}" already exists`);
      }
      throw e;
    }
  }

  // ─── Update ──────────────────────────────────────────────────────

  async updateCourse(id: string, dto: UpdateAdminCourseDto) {
    // Проверяем, что курс существует — чтобы вернуть 404 явно, а не
    // от Prisma «record not found».
    await this.assertCourseExists(id);

    const data: Prisma.CourseUpdateInput = {};
    // Перечисляем поля явно: нельзя слепо `...dto`, потому что
    // class-validator пропустил undefined — но мы хотим различать
    // «поле не передано» (undefined) и «явное null» (для nullable
    // полей вроде audience).
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.level !== undefined) data.level = dto.level;
    if (dto.titleKey !== undefined) data.titleKey = dto.titleKey;
    if (dto.descriptionKey !== undefined) data.descriptionKey = dto.descriptionKey;
    if (dto.audienceI18nKey !== undefined) data.audienceI18nKey = dto.audienceI18nKey;
    if (dto.hookI18nKey !== undefined) data.hookI18nKey = dto.hookI18nKey;
    if (dto.outcomeI18nKey !== undefined) data.outcomeI18nKey = dto.outcomeI18nKey;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.audience !== undefined) data.audience = dto.audience;
    if (dto.hook !== undefined) data.hook = dto.hook;
    if (dto.outcome !== undefined) data.outcome = dto.outcome;
    if (dto.coverUrl !== undefined) data.coverUrl = dto.coverUrl;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.estimatedMinutes !== undefined) data.estimatedMinutes = dto.estimatedMinutes;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;

    try {
      return await this.prisma.course.update({ where: { id }, data });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Slug already exists');
      }
      throw e;
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────

  async deleteCourse(id: string) {
    await this.assertCourseExists(id);
    // ON DELETE CASCADE на `lessons.course_id` снесёт уроки и шаги
    // (см. KS-1758 миграцию). UserCourseProgress / UserLessonProgress
    // — также cascade. Делает PostgreSQL, не Prisma.
    await this.prisma.course.delete({ where: { id } });
  }

  // ─── Reorder ─────────────────────────────────────────────────────

  async reorderCourses(dto: ReorderAdminCoursesDto) {
    const ids = dto.ids;

    // Проверяем, что переданный список покрывает все курсы — иначе
    // 400. Без этого reorder становится частичным и ломает
    // консистентность.
    const total = await this.prisma.course.count();
    if (ids.length !== total) {
      throw new BadRequestException(
        `ids must cover all courses (got ${ids.length}, total ${total})`,
      );
    }

    const existing = await this.prisma.course.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existing.length !== ids.length) {
      throw new BadRequestException('Some ids do not match existing courses');
    }

    // Транзакционно перезаписываем `order` 0..N-1 в порядке `ids`.
    await this.prisma.$transaction(
      ids.map((id, idx) =>
        this.prisma.course.update({
          where: { id },
          data: { order: idx },
        }),
      ),
    );
  }

  // ═══ Lessons (KS-1968 / B-6) ═══════════════════════════════════════

  async createLesson(courseId: string, dto: CreateAdminLessonDto) {
    await this.assertCourseExists(courseId);

    const order = dto.order ?? (await this.computeNextLessonOrder(courseId));

    try {
      return await this.prisma.lesson.create({
        data: {
          courseId,
          slug: dto.slug,
          blockKey: dto.blockKey,
          kind: dto.kind,
          titleKey: dto.titleKey,
          summaryKey: dto.summaryKey,
          title: dto.title ?? null,
          summary: dto.summary ?? null,
          estMinutes: dto.estMinutes ?? 10,
          order,
          isPublished: dto.isPublished ?? false,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          `Lesson slug "${dto.slug}" already exists in this course`,
        );
      }
      throw e;
    }
  }

  async getLessonById(id: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { order: 'asc' } },
        _count: { select: { steps: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    return lesson;
  }

  async updateLesson(id: string, dto: UpdateAdminLessonDto) {
    await this.assertLessonExists(id);

    const data: Prisma.LessonUpdateInput = {};
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.blockKey !== undefined) data.blockKey = dto.blockKey;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.titleKey !== undefined) data.titleKey = dto.titleKey;
    if (dto.summaryKey !== undefined) data.summaryKey = dto.summaryKey;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.summary !== undefined) data.summary = dto.summary;
    if (dto.estMinutes !== undefined) data.estMinutes = dto.estMinutes;
    if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;

    try {
      return await this.prisma.lesson.update({ where: { id }, data });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Lesson slug already exists in this course');
      }
      throw e;
    }
  }

  async deleteLesson(id: string) {
    await this.assertLessonExists(id);
    // ON DELETE CASCADE на `lesson_steps.lesson_id` и
    // `user_lesson_progress.lesson_id` — БД делает.
    await this.prisma.lesson.delete({ where: { id } });
  }

  async reorderLessons(courseId: string, dto: ReorderAdminLessonsDto) {
    await this.assertCourseExists(courseId);

    const ids = dto.ids;

    // Все ids должны принадлежать этому курсу и покрывать его полностью.
    const total = await this.prisma.lesson.count({ where: { courseId } });
    if (ids.length !== total) {
      throw new BadRequestException(
        `ids must cover all lessons of the course (got ${ids.length}, total ${total})`,
      );
    }

    const existing = await this.prisma.lesson.findMany({
      where: { id: { in: ids }, courseId },
      select: { id: true },
    });
    if (existing.length !== ids.length) {
      throw new BadRequestException(
        'Some ids do not match lessons of this course',
      );
    }

    await this.prisma.$transaction(
      ids.map((id, idx) =>
        this.prisma.lesson.update({
          where: { id },
          data: { order: idx },
        }),
      ),
    );
  }

  // ═══ Steps (KS-1969 / B-7) ═════════════════════════════════════════

  async createStep(lessonId: string, dto: CreateAdminStepDto, userId: string | null = null) {
    await this.assertLessonExists(lessonId);

    if (dto.type !== dto.payload.type) {
      throw new BadRequestException(
        `Step type "${dto.type}" does not match payload.type "${dto.payload.type}"`,
      );
    }

    // KS-3180 (ADR-072 §7 B1): для `game` со sourceType=workshop_analysis
    // снимаем snapshot PGN+meta из Analysis (owner-check, 403 на чужой).
    // Для остальных типов hydrate — no-op.
    const hydratedPayload = await this.gameStepHydrator.hydrate(dto.payload, userId);

    const order = dto.order ?? (await this.computeNextStepOrder(lessonId));

    return this.prisma.lessonStep.create({
      data: {
        lessonId,
        order,
        type: dto.type,
        payload: hydratedPayload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async updateStep(id: string, dto: UpdateAdminStepDto, userId: string | null = null) {
    const existing = await this.prisma.lessonStep.findUnique({
      where: { id },
      select: { id: true, type: true },
    });
    if (!existing) throw new NotFoundException('Step not found');

    // §3.4 концепта: при смене type новый payload обязателен —
    // иначе старая форма payload может оказаться несовместимой с
    // новым type, и шаг сломает рендер на FE.
    if (dto.type !== undefined && dto.type !== existing.type && dto.payload === undefined) {
      throw new BadRequestException(
        'payload is required when changing step type',
      );
    }

    // Если оба переданы — должны совпадать (как и при create).
    if (
      dto.type !== undefined &&
      dto.payload !== undefined &&
      dto.type !== dto.payload.type
    ) {
      throw new BadRequestException(
        `type "${dto.type}" does not match payload.type "${dto.payload.type}"`,
      );
    }

    const data: Prisma.LessonStepUpdateInput = {};
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.payload !== undefined) {
      // KS-3180: snapshot для game/workshop_analysis (см. createStep).
      const hydratedPayload = await this.gameStepHydrator.hydrate(dto.payload, userId);
      data.payload = hydratedPayload as unknown as Prisma.InputJsonValue;
    }

    return this.prisma.lessonStep.update({ where: { id }, data });
  }

  async deleteStep(id: string) {
    const existing = await this.prisma.lessonStep.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Step not found');
    await this.prisma.lessonStep.delete({ where: { id } });
  }

  async reorderSteps(lessonId: string, dto: ReorderAdminStepsDto) {
    await this.assertLessonExists(lessonId);

    const ids = dto.ids;
    const total = await this.prisma.lessonStep.count({ where: { lessonId } });
    if (ids.length !== total) {
      throw new BadRequestException(
        `ids must cover all steps of the lesson (got ${ids.length}, total ${total})`,
      );
    }

    const existing = await this.prisma.lessonStep.findMany({
      where: { id: { in: ids }, lessonId },
      select: { id: true },
    });
    if (existing.length !== ids.length) {
      throw new BadRequestException(
        'Some ids do not match steps of this lesson',
      );
    }

    await this.prisma.$transaction(
      ids.map((id, idx) =>
        this.prisma.lessonStep.update({
          where: { id },
          data: { order: idx },
        }),
      ),
    );
  }

  // ─── Internals ───────────────────────────────────────────────────

  private async assertCourseExists(id: string): Promise<void> {
    const found = await this.prisma.course.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Course not found');
  }

  private async assertLessonExists(id: string): Promise<void> {
    const found = await this.prisma.lesson.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Lesson not found');
  }

  private async computeNextOrder(): Promise<number> {
    const max = await this.prisma.course.aggregate({
      _max: { order: true },
    });
    return (max._max.order ?? -1) + 1;
  }

  private async computeNextLessonOrder(courseId: string): Promise<number> {
    const max = await this.prisma.lesson.aggregate({
      where: { courseId },
      _max: { order: true },
    });
    return (max._max.order ?? -1) + 1;
  }

  private async computeNextStepOrder(lessonId: string): Promise<number> {
    const max = await this.prisma.lessonStep.aggregate({
      where: { lessonId },
      _max: { order: true },
    });
    return (max._max.order ?? -1) + 1;
  }
}

/**
 * Prisma не экспортирует тип ошибок-по-коду в типобезопасном виде —
 * проверяем `code === 'P2002'` (unique violation) на duck-typed
 * объекте.
 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'P2002'
  );
}
