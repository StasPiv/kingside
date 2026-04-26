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
  constructor(private readonly prisma: PrismaService) {}

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

  // ─── Internals ───────────────────────────────────────────────────

  private async assertCourseExists(id: string): Promise<void> {
    const found = await this.prisma.course.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Course not found');
  }

  private async computeNextOrder(): Promise<number> {
    const max = await this.prisma.course.aggregate({
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
