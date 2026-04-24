import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserCourseRequest,
  CreateUserLessonRequest,
  UpdateUserCourseRequest,
  UserCourseDto,
  UserCourseListResponse,
  UserCoursePlayProgressDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugService } from './slug.service';

/**
 * UserCoursesService — CRUD пользовательского курса (ADR-026 §2.5,
 * KS-1829).
 *
 * Валидация payload'а и лимиты (BE-3) здесь не делаются — только
 * happy-path. Rate-limit (BE-6) — снаружи декоратором `@UserRateLimit`.
 * Авторизация (BE-2 текущий scope) — снаружи `UserCourseOwnerGuard`,
 * так что в сервис мы приходим уже с «разрешённым» userId/resource.
 *
 * `ownerId` передаётся явно в каждый мутирующий метод — это страхует
 * нас от случая, когда guard кто-то снимет с роута: сервис не
 * «заберёт» чужой курс.
 */
@Injectable()
export class UserCoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slug: SlugService,
  ) {}

  // ─── Listings ────────────────────────────────────────────────────

  /**
   * Список курсов пользователя (`mine=1`) либо список публичных
   * (`mine=0`). В MVP публичный каталог не отфильтрован (ADR §2.6 —
   * «публичный каталог вне MVP»): возвращаем все `isPublic=true`.
   * Реальный каталог с модерацией — отдельной задачей после запуска.
   */
  async list(
    userId: string,
    opts: { mine: boolean },
  ): Promise<UserCourseListResponse> {
    const rows = await this.prisma.userCourse.findMany({
      where: opts.mine ? { ownerId: userId } : { isPublic: true },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { lessons: true } } },
    });
    return { data: rows.map(toCourseDto) };
  }

  // ─── Read one ─────────────────────────────────────────────────────

  /**
   * Курс по slug + короткий список уроков. Доступ (owner ИЛИ публичный)
   * уже проверен `UserCourseOwnerGuard`, здесь только сборка DTO.
   *
   * `progress` — текущего `userId`, если он запускал курс. Для
   * анонимного просмотра публичного курса progress будет null — это ОК.
   */
  async getBySlug(
    userId: string,
    slug: string,
  ): Promise<UserCourseWithLessonsResponse> {
    const course = await this.prisma.userCourse.findUnique({
      where: { slug },
      include: {
        _count: { select: { lessons: true } },
        lessons: {
          orderBy: { order: 'asc' },
          include: { _count: { select: { steps: true } } },
        },
      },
    });
    if (!course) throw new NotFoundException('Resource not found');

    const progress = await this.prisma.userCoursePlayProgress.findUnique({
      where: { userId_userCourseId: { userId, userCourseId: course.id } },
    });

    return {
      course: toCourseDto(course),
      lessons: course.lessons.map(toLessonDto),
      progress: progress ? toCoursePlayProgressDto(progress) : null,
    };
  }

  // ─── Mutations ───────────────────────────────────────────────────

  /**
   * Создание нового курса.
   *
   * Slug: если явно передан в body — валидируется `SlugService.validateExplicit`
   * + проверка коллизии через unique-индекс БД; иначе — генерируется
   * автоматически из title (`SlugService.generateUnique`) с внутренней
   * регенерацией при случайной коллизии nanoid'а.
   */
  async create(
    ownerId: string,
    body: CreateUserCourseRequest,
  ): Promise<UserCourseDto> {
    if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) {
      // Жёсткая минимальная валидация — без неё slug-генератор упадёт.
      // Полноценные лимиты (1..120 символов и т.п.) — задача BE-3.
      throw new BadRequestException('title is required');
    }

    const slug = body.slug
      ? this.slug.validateExplicit(body.slug)
      : await this.slug.generateUnique(body.title);

    try {
      const created = await this.prisma.userCourse.create({
        data: {
          ownerId,
          slug,
          title: body.title,
          description: body.description ?? null,
          isPublic: body.isPublic ?? false,
        },
        include: { _count: { select: { lessons: true } } },
      });
      return toCourseDto(created);
    } catch (e) {
      // Случилась коллизия — в случае явного slug это «занят», в случае
      // сгенерированного — гонка с параллельным create после generateUnique.
      if (isPrismaUniqueViolation(e)) {
        throw new BadRequestException(
          body.slug ? 'slug already taken' : 'slug collision, retry',
        );
      }
      throw e;
    }
  }

  /**
   * Обновление полей курса. Guard гарантирует, что этим ручкам могут
   * пользоваться только owner'ы, но мы дополнительно сверяем ownerId —
   * см. комментарий в доке класса.
   */
  async update(
    ownerId: string,
    courseId: string,
    body: UpdateUserCourseRequest,
  ): Promise<UserCourseDto> {
    await this.assertOwner(ownerId, courseId);

    const updated = await this.prisma.userCourse.update({
      where: { id: courseId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.isPublic !== undefined ? { isPublic: body.isPublic } : {}),
      },
      include: { _count: { select: { lessons: true } } },
    });
    return toCourseDto(updated);
  }

  async delete(ownerId: string, courseId: string): Promise<void> {
    await this.assertOwner(ownerId, courseId);
    await this.prisma.userCourse.delete({ where: { id: courseId } });
  }

  /**
   * Добавить урок в курс. `order` — автоинкрементом = `max(order)+1`;
   * отдельного API для переупорядочивания уроков в MVP нет (фронт
   * меняет через PATCH на конкретный урок). Всё внутри транзакции,
   * чтобы два параллельных POST не получили один и тот же order.
   */
  async addLesson(
    ownerId: string,
    courseId: string,
    body: CreateUserLessonRequest,
  ): Promise<UserLessonDto> {
    await this.assertOwner(ownerId, courseId);
    if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) {
      throw new BadRequestException('title is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.userLesson.findFirst({
        where: { userCourseId: courseId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const next = (last?.order ?? -1) + 1;
      const created = await tx.userLesson.create({
        data: {
          userCourseId: courseId,
          order: next,
          title: body.title,
          estMinutes: body.estMinutes ?? null,
        },
        include: { _count: { select: { steps: true } } },
      });
      return toLessonDto(created);
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private async assertOwner(ownerId: string, courseId: string): Promise<void> {
    const row = await this.prisma.userCourse.findUnique({
      where: { id: courseId },
      select: { ownerId: true },
    });
    if (!row) throw new NotFoundException('Resource not found');
    if (row.ownerId !== ownerId) {
      // 404 единым кодом (ADR §2.5). Но внутри сервиса нам важнее
      // именно этот сигнал, чтобы не перепутать с другими 404.
      throw new ForbiddenException('Resource not found');
    }
  }
}

// ─── DTO mappers ──────────────────────────────────────────────────────

export function toCourseDto(
  row: {
    id: string;
    ownerId: string;
    slug: string;
    title: string;
    description: string | null;
    isPublic: boolean;
    createdAt: Date;
    updatedAt: Date;
    _count?: { lessons: number };
  },
): UserCourseDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    isPublic: row.isPublic,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lessonCount: row._count?.lessons ?? 0,
  };
}

export function toLessonDto(
  row: {
    id: string;
    userCourseId: string;
    order: number;
    title: string;
    estMinutes: number | null;
    _count?: { steps: number };
  },
): UserLessonDto {
  return {
    id: row.id,
    userCourseId: row.userCourseId,
    order: row.order,
    title: row.title,
    estMinutes: row.estMinutes,
    stepCount: row._count?.steps ?? 0,
  };
}

export function toCoursePlayProgressDto(row: {
  userCourseId: string;
  completedLessonsCount: number;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
}): UserCoursePlayProgressDto {
  return {
    userCourseId: row.userCourseId,
    completedLessonsCount: row.completedLessonsCount,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

// ─── Prisma error helpers ────────────────────────────────────────────

function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'P2002'
  );
}
