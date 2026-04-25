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
  UserCourseDto,
  UserCourseListResponse,
  UserCoursePlayProgressDto,
  UserCourseStatsDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugService } from './slug.service';
import { USER_COURSES_LIMITS } from './user-courses-limits';

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

    // KS-1885: stats только владельцам. Чтобы не делать 2N count'ов
    // (по 2 на каждую карточку), батчим всех owner'ских курсов в
    // ровно два `groupBy` (один общий enrolled, один completed) с
    // фильтром `userCourseId IN (...)`. Оба запроса бьют по индексу
    // `user_course_play_progress (user_id, user_course_id)` — план
    // постгрес'а это IndexOnlyScan.
    const ownedIds = rows.filter((r) => r.ownerId === userId).map((r) => r.id);
    const statsByCourseId = await this.computeStatsForCourses(ownedIds);

    return {
      data: rows.map((r) =>
        toCourseDto(r, { stats: statsByCourseId.get(r.id) }),
      ),
    };
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

    // KS-1885: статистика прохождений только владельцу. Здесь — два
    // count'а по тому же индексу `(user_id, user_course_id)` (он
    // covering для `where user_course_id = ?` через подзапрос на
    // partial). Параллелим, чтобы не серилизовать round-trip'ы.
    const isOwner = course.ownerId === userId;
    const stats = isOwner ? await this.computeStatsForCourse(course.id) : undefined;

    return {
      course: toCourseDto(course, { stats }),
      lessons: course.lessons.map(toLessonDto),
      progress: progress ? toCoursePlayProgressDto(progress) : null,
    };
  }

  /**
   * Считает `UserCourseStatsDto` для одного курса двумя count'ами
   * (общий enrolled + completed). Без `groupBy`, потому что для одной
   * сущности он избыточен — два узких COUNT'а по индексу дают тот же
   * план без overhead'а группировки.
   */
  private async computeStatsForCourse(
    userCourseId: string,
  ): Promise<UserCourseStatsDto> {
    const [enrolledCount, completedCount] = await Promise.all([
      this.prisma.userCoursePlayProgress.count({ where: { userCourseId } }),
      this.prisma.userCoursePlayProgress.count({
        where: { userCourseId, completedAt: { not: null } },
      }),
    ]);
    return {
      enrolledCount,
      completedCount,
      inProgressCount: Math.max(enrolledCount - completedCount, 0),
    };
  }

  /**
   * Батчевая версия `computeStatsForCourse` для списка `mine=true`:
   * ровно два `groupBy` независимо от длины списка. Возвращает Map
   * `userCourseId → stats` только для тех id, по которым в БД есть
   * хотя бы одна запись прогресса; для остальных вызывающий должен
   * подставить нули (см. использование в `list`).
   */
  private async computeStatsForCourses(
    userCourseIds: string[],
  ): Promise<Map<string, UserCourseStatsDto>> {
    const out = new Map<string, UserCourseStatsDto>();
    if (userCourseIds.length === 0) return out;

    const [enrolledGroups, completedGroups] = await Promise.all([
      this.prisma.userCoursePlayProgress.groupBy({
        by: ['userCourseId'],
        where: { userCourseId: { in: userCourseIds } },
        _count: { userCourseId: true },
      }),
      this.prisma.userCoursePlayProgress.groupBy({
        by: ['userCourseId'],
        where: {
          userCourseId: { in: userCourseIds },
          completedAt: { not: null },
        },
        _count: { userCourseId: true },
      }),
    ]);

    const completedByCourseId = new Map<string, number>();
    for (const g of completedGroups) {
      completedByCourseId.set(g.userCourseId, g._count.userCourseId);
    }

    // Включаем все ownedIds — даже без записей прогресса, чтобы автору
    // отдавать честные нули (а не отсутствие поля). Иначе UI не сможет
    // отличить «никто не записан» от «не-owner».
    for (const id of userCourseIds) {
      out.set(id, { enrolledCount: 0, completedCount: 0, inProgressCount: 0 });
    }
    for (const g of enrolledGroups) {
      const enrolled = g._count.userCourseId;
      const completed = completedByCourseId.get(g.userCourseId) ?? 0;
      out.set(g.userCourseId, {
        enrolledCount: enrolled,
        completedCount: completed,
        inProgressCount: Math.max(enrolled - completed, 0),
      });
    }
    return out;
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
      // Минимальный guard на случай, если route вызван в обход
      // ValidationPipe (в тестах, например). Полноценные правила
      // длины/непустоты — в `CreateUserCourseDto`.
      throw new BadRequestException('title is required');
    }

    // Лимит на количество курсов одного автора (ADR-026 §2.2, BE-3).
    const ownerCourseCount = await this.prisma.userCourse.count({
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
      // Лимит 30 уроков/курс (ADR-026 §2.2). Считаем в транзакции,
      // чтобы две параллельные попытки «добить до 30» не обошли
      // проверку.
      const lessonCount = await tx.userLesson.count({
        where: { userCourseId: courseId },
      });
      if (lessonCount >= USER_COURSES_LIMITS.lessonsPerCourse) {
        throw new BadRequestException(
          `Lessons per course limit reached (${USER_COURSES_LIMITS.lessonsPerCourse})`,
        );
      }

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

      // KS-1881: добавление нового урока инвалидирует «курс пройден»
      // у всех студентов, у кого `completedAt` стоял (общее число
      // уроков выросло — старая 100%-отметка больше не отражает
      // реальность). Сбрасываем `completedAt` в null атомарно в той
      // же транзакции, чтобы не было окна, когда курс одновременно
      // содержит «новый урок» и помечен у студента «пройдено».
      // `completedLessonsCount` оставляем как есть — он не врёт, просто
      // теперь меньше нового total.
      await tx.userCoursePlayProgress.updateMany({
        where: { userCourseId: courseId, completedAt: { not: null } },
        data: { completedAt: null },
      });

      return toLessonDto(created);
    });
  }

  /**
   * Массовая перестановка `order` уроков курса в одной транзакции
   * (KS-1862, FE-R8/FE-R6 — альтернатива N PATCH'ам).
   *
   * На входе — массив id в нужном порядке; всем выставляется
   * `order = index`. Проверяем, что:
   *  - `body.ids` непуст;
   *  - все id принадлежат именно этому курсу (никакой подмены чужих
   *    уроков или шагов);
   *  - список полный — содержит ровно все уроки курса. Частичный
   *    reorder не поддерживаем, чтобы оставшиеся уроки не получили
   *    «дыры» в order'е.
   *
   * Реализация — по образцу `UserLessonsService.reorderSteps`: две
   * фазы update'а (сначала в безопасный offset `+1_000_000`, потом в
   * целевые значения). На (userCourseId, order) unique-констрейнта
   * сейчас нет, но практика защищает на случай будущего ужесточения
   * схемы и делает промежуточное состояние в транзакции явно невалидным
   * только один такт.
   */
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
      const lessons = await tx.userLesson.findMany({
        where: { userCourseId: courseId },
        select: { id: true },
      });
      const allowed = new Set(lessons.map((l) => l.id));
      for (const id of body.ids) {
        if (!allowed.has(id)) {
          throw new BadRequestException(`lesson ${id} does not belong to course`);
        }
      }
      if (body.ids.length !== lessons.length) {
        throw new BadRequestException(
          'ids must list every lesson of the course (reorder requires full list)',
        );
      }

      // Защита от дублей в `body.ids` — без неё конкретный id попал бы
      // в два offset'а и второй update переписал бы первый.
      if (new Set(body.ids).size !== body.ids.length) {
        throw new BadRequestException('ids must be unique');
      }

      await Promise.all(
        body.ids.map((id, idx) =>
          tx.userLesson.update({
            where: { id },
            data: { order: 1_000_000 + idx },
          }),
        ),
      );
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.userLesson.update({
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
  // KS-1885: stats передаёт сервис, маппер сам не знает про owner-чек.
  // Если `stats` undefined — поле не попадёт в JSON-ответ (для
  // не-владельцев). Передавать `undefined` явно — нормальный API
  // contract, не путаемся с `null`.
  opts?: { stats?: UserCourseStatsDto },
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
    ...(opts?.stats ? { stats: opts.stats } : {}),
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
