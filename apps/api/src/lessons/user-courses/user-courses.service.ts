import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserCourseRequest,
  CreateUserLessonRequest,
  ReorderUserLessonsRequest,
  UpdateUserCourseRequest,
  CourseAuthorDto,
  CourseAuthorListResponse,
  UserCourseDto,
  UserCourseListResponse,
  UserCoursePlayProgressDto,
  UserCourseStatsDto,
  UserCourseWithLessonsResponse,
  UserEnrolledCourseDto,
  UserEnrolledCoursesListResponse,
  UserLessonDto,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache.service';
import { SlugService } from './slug.service';
import { USER_COURSES_LIMITS } from './user-courses-limits';

/** KS-1918: префикс кеша для `/lessons/courses/authors`. */
const AUTHORS_CACHE_PREFIX = 'lessons:authors';
const AUTHORS_CACHE_TTL_SEC = 5 * 60;

/**
 * UserCoursesService — CRUD пользовательского курса (ADR-026 §2.5,
 * KS-1829).
 *
 * KS-2648 / ADR-054 Phase E2. Сервис переключён на единые таблицы:
 *   * `prisma.course` (`courses`) с фильтром `ownerId !== null` —
 *     вместо `prisma.userCourse`. Системные курсы (`ownerId IS NULL`)
 *     в выборку не попадают.
 *   * `prisma.lesson` / `prisma.lessonStep` — вместо `userLesson`/
 *     `userLessonStep`.
 *   * `prisma.userCourseProgress` / `prisma.userLessonProgress` —
 *     вместо `userCoursePlayProgress` / `userLessonPlayProgress`.
 *     Системный progress-агрегат покрывает оба сценария (после Phase B
 *     copy данные синхронизированы; в Phase E3 таблицы переименуются
 *     в `course_progress` / `lesson_progress`).
 *
 * DTO-контракт (`UserCourseDto`, `UserLessonDto`,
 * `UserCoursePlayProgressDto`, `UserCourseStatsDto`) сохранён 1:1 —
 * фронт не задет. Под капотом:
 *   * `userCourseId` ← `course.id`;
 *   * `userLessonId` ← `lesson.id`;
 *   * `lastActivityAt` ← `updatedAt`;
 *   * `completedLessonsCount` — вычисляется on-demand по
 *     `userLessonProgress.completedAt IS NOT NULL` для уроков курса
 *     (системная таблица не хранит счётчик).
 *
 * Валидация payload'а и лимиты (BE-3) здесь не делаются — только
 * happy-path. Rate-limit (BE-6) — снаружи декоратором `@UserRateLimit`.
 * Авторизация (BE-2) — снаружи `UserCourseOwnerGuard`, так что в
 * сервис мы приходим уже с «разрешённым» userId/resource.
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
    private readonly cache: CacheService,
  ) {}

  // ─── Listings ────────────────────────────────────────────────────

  /**
   * Список курсов пользователя (`mine=1`) либо список публичных
   * пользовательских (`mine=0`).
   */
  async list(
    userId: string,
    opts: { mine: boolean; limit?: number; offset?: number },
  ): Promise<UserCourseListResponse> {
    const take = clampInt(opts.limit ?? 50, 1, 50);
    const skip = clampInt(opts.offset ?? 0, 0, 1000);
    // KS-2648: `course.ownerId IS NOT NULL` обязательно — иначе попадут
    // системные курсы.
    const rows = await this.prisma.course.findMany({
      where: opts.mine
        ? { ownerId: userId }
        : { isPublic: true, ownerId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { lessons: true } } },
      take,
      skip,
    });

    const ownedIds = rows.filter((r) => r.ownerId === userId).map((r) => r.id);
    const statsByCourseId = await this.computeStatsForCourses(ownedIds);

    return {
      data: rows.map((r) =>
        toCourseDto(r, { stats: statsByCourseId.get(r.id) }),
      ),
    };
  }

  /**
   * KS-1914: список публичных курсов одного автора.
   */
  async listPublicByOwner(
    ownerId: string,
  ): Promise<UserCourseListResponse> {
    const rows = await this.prisma.course.findMany({
      where: { ownerId, isPublic: true },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { lessons: true } } },
    });
    return {
      data: rows.map((r) => toCourseDto(r)),
    };
  }

  /**
   * KS-1918 / ADR-030 §3.2: список авторов с агрегатом по их публичным
   * курсам.
   */
  async listAuthors(
    opts: { sort?: 'courses' | 'recent'; limit?: number; offset?: number } = {},
  ): Promise<CourseAuthorListResponse> {
    const sort = opts.sort ?? 'courses';
    const limit = clampInt(opts.limit ?? 50, 1, 50);
    const offset = clampInt(opts.offset ?? 0, 0, 1000);
    const cacheKey = `${AUTHORS_CACHE_PREFIX}:${sort}:${limit}:${offset}`;

    return this.cache.getOrSet(cacheKey, AUTHORS_CACHE_TTL_SEC, () =>
      this.computeAuthors({ sort, limit, offset }),
    );
  }

  private async computeAuthors(opts: {
    sort: 'courses' | 'recent';
    limit: number;
    offset: number;
  }): Promise<CourseAuthorListResponse> {
    // KS-2648: groupBy на единой `courses` с фильтром `isPublic AND
    // ownerId IS NOT NULL` — отсекаем системные.
    const groups = await this.prisma.course.groupBy({
      by: ['ownerId'],
      where: { isPublic: true, ownerId: { not: null } },
      _count: { id: true },
      _max: { updatedAt: true },
    });

    if (groups.length === 0) return { data: [], total: 0 };

    const ownerIds = groups
      .map((g) => g.ownerId)
      .filter((x): x is string => x !== null);

    const [publicCourses, users] = await Promise.all([
      this.prisma.course.findMany({
        where: { ownerId: { in: ownerIds }, isPublic: true },
        orderBy: { updatedAt: 'desc' },
        select: { ownerId: true, slug: true, title: true, updatedAt: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, username: true },
      }),
    ]);

    const latestByOwner = new Map<
      string,
      { slug: string; title: string | null; updatedAt: Date }
    >();
    for (const c of publicCourses) {
      if (c.ownerId === null) continue;
      if (!latestByOwner.has(c.ownerId)) {
        latestByOwner.set(c.ownerId, {
          slug: c.slug,
          title: c.title,
          updatedAt: c.updatedAt,
        });
      }
    }

    const userById = new Map<string, { id: string; username: string | null }>();
    for (const u of users) userById.set(u.id, u);

    const dtos: CourseAuthorDto[] = [];
    for (const g of groups) {
      if (g.ownerId === null) continue;
      const u = userById.get(g.ownerId);
      const latest = latestByOwner.get(g.ownerId);
      if (!u || !u.username || !latest || !g._max.updatedAt) continue;
      dtos.push({
        user: { id: u.id, username: u.username },
        publicCoursesCount: g._count.id,
        lastCourseUpdatedAt: g._max.updatedAt.toISOString(),
        latestCourseSlug: latest.slug,
        // KS-2648: latest.title может быть null (для системных вариантов
        // без inline title); фолбэк на slug — UI пробросит slug как
        // подпись если title пуст.
        latestCourseTitle: latest.title ?? latest.slug,
      });
    }

    dtos.sort((a, b) => {
      if (opts.sort === 'recent') {
        return b.lastCourseUpdatedAt.localeCompare(a.lastCourseUpdatedAt);
      }
      const byCount = b.publicCoursesCount - a.publicCoursesCount;
      if (byCount !== 0) return byCount;
      return b.lastCourseUpdatedAt.localeCompare(a.lastCourseUpdatedAt);
    });

    return {
      data: dtos.slice(opts.offset, opts.offset + opts.limit),
      total: dtos.length,
    };
  }

  /** KS-1918: инвалидация кеша authors. */
  private async invalidateAuthorsCache(): Promise<void> {
    await this.cache.invalidate(`${AUTHORS_CACHE_PREFIX}:*`);
  }

  /**
   * KS-1889: «Курсы, которые я прохожу». Возвращает чужие пользовательские
   * курсы (`course.ownerId !== userId AND ownerId IS NOT NULL`), у которых
   * у текущего пользователя есть запись прогресса.
   */
  async listEnrolled(
    userId: string,
  ): Promise<UserEnrolledCoursesListResponse> {
    // KS-2648: системный `userCourseProgress` обслуживает оба сценария.
    // Чтобы не возвращать enrolled на системные курсы (там другая
    // карточка) — фильтр `ownerId IS NOT NULL`.
    const rows = await this.prisma.userCourseProgress.findMany({
      where: {
        userId,
        course: {
          AND: [
            { ownerId: { not: null } },
            { ownerId: { not: userId } },
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        course: {
          include: {
            _count: { select: { lessons: true } },
            lessons: {
              where: { ownerId: { not: null } },
              orderBy: { order: 'asc' },
              select: { id: true, order: true, title: true },
            },
          },
        },
      },
    });

    const allLessonIds = rows.flatMap((r) => r.course.lessons.map((l) => l.id));
    const lessonProgressByLessonId = new Map<
      string,
      { completedAt: Date | null }
    >();
    if (allLessonIds.length > 0) {
      const lessonRows = await this.prisma.userLessonProgress.findMany({
        where: { userId, lessonId: { in: allLessonIds } },
        select: { lessonId: true, completedAt: true },
      });
      for (const lr of lessonRows) {
        lessonProgressByLessonId.set(lr.lessonId, {
          completedAt: lr.completedAt,
        });
      }
    }

    return {
      data: rows.map((row): UserEnrolledCourseDto => {
        const lessons = row.course.lessons;
        const currentIdx = lessons.findIndex(
          (l) => lessonProgressByLessonId.get(l.id)?.completedAt == null,
        );
        const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

        // KS-2648: completedLessonsCount считаем on-demand.
        const completedCount = lessons.filter(
          (l) => lessonProgressByLessonId.get(l.id)?.completedAt != null,
        ).length;

        return {
          ...toCourseDto(row.course),
          progress: toCoursePlayProgressDto(
            {
              courseId: row.courseId,
              startedAt: row.startedAt,
              updatedAt: row.updatedAt,
              completedAt: row.completedAt,
            },
            {
              completedLessonsCount: completedCount,
              currentLesson: currentLesson
                ? {
                    slug: currentLesson.id,
                    title: currentLesson.title ?? '',
                    order: currentIdx + 1,
                  }
                : null,
            },
          ),
        };
      }),
    };
  }

  // ─── Read one ─────────────────────────────────────────────────────

  async getBySlug(
    userId: string,
    slug: string,
  ): Promise<UserCourseWithLessonsResponse> {
    // KS-2648: ищем в namespace владельца либо публичный пользовательский.
    // Сначала — собственный (типичный happy-path для редактора), потом
    // публичный.
    const course = await this.prisma.course.findFirst({
      where: {
        slug,
        ownerId: { not: null },
        OR: [{ ownerId: userId }, { isPublic: true }],
      },
      include: {
        _count: { select: { lessons: true } },
        lessons: {
          where: { ownerId: { not: null } },
          orderBy: { order: 'asc' },
          include: { _count: { select: { steps: true } } },
        },
      },
    });
    if (!course) throw new NotFoundException('Resource not found');

    const progress = await this.prisma.userCourseProgress.findUnique({
      where: { userId_courseId: { userId, courseId: course.id } },
    });

    const isOwner = course.ownerId === userId;
    const stats = isOwner
      ? await this.computeStatsForCourse(course.id)
      : undefined;

    // KS-4921: per-lesson completedAt считается ВСЕГДА (не только при
    // наличии записи прогресса курса) — страница курса показывает
    // честный статус каждого урока, без эвристики «первые N пройдены».
    const lessonIds = course.lessons.map((l) => l.id);
    const lessonProgressRows =
      lessonIds.length > 0
        ? await this.prisma.userLessonProgress.findMany({
            where: { userId, lessonId: { in: lessonIds } },
            select: { lessonId: true, completedAt: true },
          })
        : [];
    const completedAtByLesson = new Map(
      lessonProgressRows.map((lp) => [lp.lessonId, lp.completedAt]),
    );

    let currentLessonForProgress:
      | { slug: string; title: string; order: number }
      | null = null;
    let completedLessonsCount = 0;
    if (progress) {
      const completedSet = new Set(
        lessonProgressRows
          .filter((lp) => lp.completedAt != null)
          .map((lp) => lp.lessonId),
      );
      completedLessonsCount = completedSet.size;
      const currentIdx = course.lessons.findIndex(
        (l) => !completedSet.has(l.id),
      );
      if (currentIdx >= 0) {
        const cl = course.lessons[currentIdx];
        currentLessonForProgress = {
          slug: cl.id,
          title: cl.title ?? '',
          order: currentIdx + 1,
        };
      }
    }

    return {
      course: toCourseDto(course, { stats }),
      lessons: course.lessons.map((l) =>
        toLessonDto(l, completedAtByLesson.get(l.id) ?? null),
      ),
      progress: progress
        ? toCoursePlayProgressDto(
            {
              courseId: course.id,
              startedAt: progress.startedAt,
              updatedAt: progress.updatedAt,
              completedAt: progress.completedAt,
            },
            {
              completedLessonsCount,
              currentLesson: currentLessonForProgress,
            },
          )
        : null,
    };
  }

  /**
   * Считает `UserCourseStatsDto` для одного курса.
   * KS-2648: считаем по `userCourseProgress.courseId` (системная
   * таблица). Для пользовательских курсов записи системного прогресса
   * привязаны к ним так же, как раньше к `userCoursePlayProgress`.
   */
  private async computeStatsForCourse(
    courseId: string,
  ): Promise<UserCourseStatsDto> {
    const [enrolledCount, completedCount] = await Promise.all([
      this.prisma.userCourseProgress.count({ where: { courseId } }),
      this.prisma.userCourseProgress.count({
        where: { courseId, completedAt: { not: null } },
      }),
    ]);
    return {
      enrolledCount,
      completedCount,
      inProgressCount: Math.max(enrolledCount - completedCount, 0),
    };
  }

  /**
   * Батчевая версия `computeStatsForCourse` для списка `mine=true`.
   */
  private async computeStatsForCourses(
    courseIds: string[],
  ): Promise<Map<string, UserCourseStatsDto>> {
    const out = new Map<string, UserCourseStatsDto>();
    if (courseIds.length === 0) return out;

    const [enrolledGroups, completedGroups] = await Promise.all([
      this.prisma.userCourseProgress.groupBy({
        by: ['courseId'],
        where: { courseId: { in: courseIds } },
        _count: { courseId: true },
      }),
      this.prisma.userCourseProgress.groupBy({
        by: ['courseId'],
        where: {
          courseId: { in: courseIds },
          completedAt: { not: null },
        },
        _count: { courseId: true },
      }),
    ]);

    const completedByCourseId = new Map<string, number>();
    for (const g of completedGroups) {
      completedByCourseId.set(g.courseId, g._count.courseId);
    }

    for (const id of courseIds) {
      out.set(id, { enrolledCount: 0, completedCount: 0, inProgressCount: 0 });
    }
    for (const g of enrolledGroups) {
      const enrolled = g._count.courseId;
      const completed = completedByCourseId.get(g.courseId) ?? 0;
      out.set(g.courseId, {
        enrolledCount: enrolled,
        completedCount: completed,
        inProgressCount: Math.max(enrolled - completed, 0),
      });
    }
    return out;
  }

  // ─── Mutations ───────────────────────────────────────────────────

  async create(
    ownerId: string,
    body: CreateUserCourseRequest,
  ): Promise<UserCourseDto> {
    if (
      !body ||
      typeof body.title !== 'string' ||
      body.title.trim().length === 0
    ) {
      throw new BadRequestException('title is required');
    }

    // Лимит на количество курсов одного автора.
    const ownerCourseCount = await this.prisma.course.count({
      where: { ownerId },
    });
    if (ownerCourseCount >= USER_COURSES_LIMITS.coursesPerUser) {
      throw new BadRequestException(
        `Courses per user limit reached (${USER_COURSES_LIMITS.coursesPerUser})`,
      );
    }

    const slug = body.slug
      ? this.slug.validateExplicit(body.slug)
      : await this.slug.generateUnique(body.title);

    try {
      // KS-2648: пишем в `courses` с обязательным `ownerId`. Системные
      // поля (level/titleKey/descriptionKey/difficulty) — null, default
      // (см. Phase A nullable-миграция). `lang='ru'` — Phase B.
      const created = await this.prisma.course.create({
        data: {
          ownerId,
          slug,
          lang: 'ru',
          title: body.title,
          description: body.description ?? null,
          isPublic: body.isPublic ?? false,
        },
        include: { _count: { select: { lessons: true } } },
      });
      if (created.isPublic) {
        await this.invalidateAuthorsCache().catch(() => {});
      }
      return toCourseDto(created);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        throw new BadRequestException(
          body.slug ? 'slug already taken' : 'slug collision, retry',
        );
      }
      throw e;
    }
  }

  async update(
    ownerId: string,
    courseId: string,
    body: UpdateUserCourseRequest,
  ): Promise<UserCourseDto> {
    await this.assertOwner(ownerId, courseId);

    const updated = await this.prisma.course.update({
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
    await this.invalidateAuthorsCache().catch(() => {});
    return toCourseDto(updated);
  }

  async delete(ownerId: string, courseId: string): Promise<void> {
    await this.assertOwner(ownerId, courseId);
    await this.prisma.course.delete({ where: { id: courseId } });
    await this.invalidateAuthorsCache().catch(() => {});
  }

  async addLesson(
    ownerId: string,
    courseId: string,
    body: CreateUserLessonRequest,
  ): Promise<UserLessonDto> {
    await this.assertOwner(ownerId, courseId);
    if (
      !body ||
      typeof body.title !== 'string' ||
      body.title.trim().length === 0
    ) {
      throw new BadRequestException('title is required');
    }

    return this.prisma.$transaction(async (tx) => {
      // Лимит уроков/курс.
      const lessonCount = await tx.lesson.count({ where: { courseId } });
      if (lessonCount >= USER_COURSES_LIMITS.lessonsPerCourse) {
        throw new BadRequestException(
          `Lessons per course limit reached (${USER_COURSES_LIMITS.lessonsPerCourse})`,
        );
      }

      const last = await tx.lesson.findFirst({
        where: { courseId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const next = (last?.order ?? -1) + 1;
      // KS-2648: денормализуем `ownerId` урока из курса (Phase A).
      const created = await tx.lesson.create({
        data: {
          courseId,
          ownerId,
          order: next,
          title: body.title,
          estMinutes: body.estMinutes ?? 10,
          lang: 'ru',
        },
        include: { _count: { select: { steps: true } } },
      });

      // KS-1881: добавление нового урока инвалидирует «курс пройден»
      // у всех студентов, у кого `completedAt` стоял.
      await tx.userCourseProgress.updateMany({
        where: { courseId, completedAt: { not: null } },
        data: { completedAt: null },
      });

      return toLessonDto(created);
    });
  }

  async reorderLessons(
    ownerId: string,
    courseId: string,
    body: ReorderUserLessonsRequest,
  ): Promise<{ ids: string[] }> {
    await this.assertOwner(ownerId, courseId);

    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      throw new BadRequestException('ids is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const lessons = await tx.lesson.findMany({
        where: { courseId },
        select: { id: true },
      });
      const allowed = new Set(lessons.map((l) => l.id));
      for (const id of body.ids) {
        if (!allowed.has(id)) {
          throw new BadRequestException(
            `lesson ${id} does not belong to course`,
          );
        }
      }
      if (body.ids.length !== lessons.length) {
        throw new BadRequestException(
          'ids must list every lesson of the course (reorder requires full list)',
        );
      }
      if (new Set(body.ids).size !== body.ids.length) {
        throw new BadRequestException('ids must be unique');
      }

      await Promise.all(
        body.ids.map((id, idx) =>
          tx.lesson.update({
            where: { id },
            data: { order: 1_000_000 + idx },
          }),
        ),
      );
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.lesson.update({
            where: { id },
            data: { order: idx },
          }),
        ),
      );
      return { ids: body.ids };
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private async assertOwner(ownerId: string, courseId: string): Promise<void> {
    const row = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { ownerId: true },
    });
    if (!row) throw new NotFoundException('Resource not found');
    if (row.ownerId !== ownerId) {
      throw new ForbiddenException('Resource not found');
    }
  }
}

// ─── Internal helpers ────────────────────────────────────────────────

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ─── DTO mappers ──────────────────────────────────────────────────────

/**
 * KS-2648: row теперь из `courses`. `ownerId` обязателен (для
 * пользовательского курса не null); `title`/`description` могут быть
 * null у системных, но мы сюда системные не пускаем (фильтр выше).
 * Защитный `?? ''` на title — на случай странных данных в проде.
 */
export function toCourseDto(
  row: {
    id: string;
    ownerId: string | null;
    slug: string;
    title: string | null;
    description: string | null;
    isPublic: boolean;
    createdAt: Date;
    updatedAt: Date;
    _count?: { lessons: number };
  },
  opts?: { stats?: UserCourseStatsDto },
): UserCourseDto {
  return {
    id: row.id,
    ownerId: row.ownerId ?? '',
    slug: row.slug,
    title: row.title ?? '',
    description: row.description,
    isPublic: row.isPublic,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lessonCount: row._count?.lessons ?? 0,
    ...(opts?.stats ? { stats: opts.stats } : {}),
  };
}

/**
 * KS-2648: row теперь из `lessons`. `courseId` (системное) маппится в
 * `userCourseId` legacy DTO. `title` для пользовательских непуст.
 */
export function toLessonDto(
  row: {
    id: string;
    courseId: string;
    order: number;
    title: string | null;
    estMinutes: number | null;
    _count?: { steps: number };
  },
  /** KS-4921: completedAt текущего пользователя (undefined — не отдавать поле). */
  completedAt?: Date | null,
): UserLessonDto {
  return {
    id: row.id,
    userCourseId: row.courseId,
    order: row.order,
    title: row.title ?? '',
    estMinutes: row.estMinutes,
    stepCount: row._count?.steps ?? 0,
    ...(completedAt !== undefined && {
      completedAt: completedAt?.toISOString() ?? null,
    }),
  };
}

/**
 * KS-2648: row теперь из `userCourseProgress` (системная таблица).
 * Маппинг под legacy `UserCoursePlayProgressDto`:
 *   * `userCourseId` ← `courseId`;
 *   * `lastActivityAt` ← `updatedAt`;
 *   * `completedLessonsCount` — вызывающий передаёт явно (вычислил
 *     по `userLessonProgress.completedAt`).
 */
export function toCoursePlayProgressDto(
  row: {
    courseId: string;
    startedAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  },
  opts: {
    completedLessonsCount: number;
    currentLesson?: { slug: string; title: string; order: number } | null;
  },
): UserCoursePlayProgressDto {
  const cl = opts.currentLesson ?? null;
  return {
    userCourseId: row.courseId,
    completedLessonsCount: opts.completedLessonsCount,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    currentLessonSlug: cl?.slug ?? null,
    currentLessonTitle: cl?.title ?? null,
    currentLessonOrder: cl?.order ?? null,
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
