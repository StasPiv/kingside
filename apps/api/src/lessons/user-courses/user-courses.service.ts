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

/** KS-1918: префикс кеша для `/lessons/user-courses/authors`. */
const AUTHORS_CACHE_PREFIX = 'lessons:authors';
const AUTHORS_CACHE_TTL_SEC = 5 * 60;

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
    private readonly cache: CacheService,
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
    opts: { mine: boolean; limit?: number; offset?: number },
  ): Promise<UserCourseListResponse> {
    // KS-1918: limit/offset нужны для ленты публичных курсов на
    // лобби `/lessons` (ADR-030 §2.1) и для будущего `/lessons/community`.
    // Дефолты: 50/0 (тот же объём, что отдавался раньше — до пагинации).
    // Clamp здесь дополнительный к Pipe-валидации в DTO query: если
    // сервис вызвали напрямую (тесты, e2e), границы всё равно
    // соблюдаются.
    const take = clampInt(opts.limit ?? 50, 1, 50);
    const skip = clampInt(opts.offset ?? 0, 0, 1000);
    const rows = await this.prisma.userCourse.findMany({
      where: opts.mine ? { ownerId: userId } : { isPublic: true },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { lessons: true } } },
      take,
      skip,
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

  /**
   * KS-1914: список публичных курсов одного автора. Используется на
   * странице профиля автора (`GET /players/:username/courses`).
   * Эндпоинт публичный, без auth, поэтому `stats` не возвращаем —
   * это авторские метрики (см. KS-1885). Сортировка та же, что у
   * `list({mine:false})`: `updatedAt DESC`.
   *
   * Один запрос без stats-batched-groupBy (не вызываем
   * `computeStatsForCourses`) — просто `findMany` с `_count.lessons`.
   * У автора обычно <20 курсов, пагинации в MVP не делаем.
   */
  async listPublicByOwner(
    ownerId: string,
  ): Promise<UserCourseListResponse> {
    const rows = await this.prisma.userCourse.findMany({
      where: { ownerId, isPublic: true },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { lessons: true } } },
    });
    return {
      // Без `opts.stats` → DTO без `stats`-поля (поле опциональное в
      // shared). Не-владелец видит карточку курса без приватных
      // авторских метрик.
      data: rows.map((r) => toCourseDto(r)),
    };
  }

  /**
   * KS-1918 / ADR-030 §3.2: список авторов с агрегатом по их публичным
   * курсам — для `CourseAuthorsBlock` на `/lessons` и таба Authors на
   * `/players`. Без auth (публичная витрина).
   *
   * SQL-логика (см. ADR §3.2):
   *   1. `groupBy({by:['ownerId']})` по `userCourse where isPublic=true`
   *      с `_count.id` (число публичных курсов автора) и
   *      `_max.updatedAt` (для sort'а 'recent' и поля `lastCourseUpdatedAt`).
   *      Существующий индекс `(isPublic, updatedAt)` покрывает план.
   *   2. Загружаем все публичные курсы для собранного списка ownerId
   *      одним `findMany`, отсортированные `updatedAt DESC` — берём
   *      первый по каждому ownerId как `latestCourse{Slug,Title}`.
   *      Distinct-on в Prisma нет, делаем groupBy в JS на одном
   *      запросе — это дешевле, чем N коррелированных subquery.
   *   3. Параллельно `user.findMany({where:{id IN ownerIds}})` для
   *      имени/аватара (схема User пока не имеет avatarUrl/displayName,
   *      эти поля в DTO остаются undefined; добавим, когда появятся).
   *   4. Sort + slice по `limit/offset`. Сортировка в JS — авторов
   *      обычно <100, индекс-supported orderBy на groupBy в Prisma
   *      ограничен (`_count` сортируется только по одному ключу).
   *
   * Кеширование: Redis 5 мин по ключу
   * `lessons:authors:<sort>:<limit>:<offset>`. Инвалидация — при
   * любых мутациях `UserCourse`, которые могут затронуть `isPublic`
   * (`create({isPublic:true})`, `update({isPublic:...})`, `delete`) —
   * см. `invalidateAuthorsCache()`.
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
    const groups = await this.prisma.userCourse.groupBy({
      by: ['ownerId'],
      where: { isPublic: true },
      _count: { id: true },
      _max: { updatedAt: true },
    });

    if (groups.length === 0) return { data: [], total: 0 };

    const ownerIds = groups.map((g) => g.ownerId);

    // Параллелим: все публичные курсы по нашим owner'ам (для latest)
    // + user-метаданные. Каждый запрос идёт по индексу — overhead
    // последовательного await'а не оправдан.
    const [publicCourses, users] = await Promise.all([
      this.prisma.userCourse.findMany({
        where: { ownerId: { in: ownerIds }, isPublic: true },
        orderBy: { updatedAt: 'desc' },
        select: { ownerId: true, slug: true, title: true, updatedAt: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, username: true },
      }),
    ]);

    // Latest course per ownerId — берём первый (массив отсортирован
    // updatedAt DESC, так что первый по ownerId = самый свежий).
    const latestByOwner = new Map<
      string,
      { slug: string; title: string; updatedAt: Date }
    >();
    for (const c of publicCourses) {
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

    // Сборка DTO. Если у user'а нет username (теоретически возможно
    // у OAuth-юзера до setup'а), пропускаем — без username нет smysla
    // показывать карточку.
    const dtos: CourseAuthorDto[] = [];
    for (const g of groups) {
      const u = userById.get(g.ownerId);
      const latest = latestByOwner.get(g.ownerId);
      if (!u || !u.username || !latest || !g._max.updatedAt) continue;
      dtos.push({
        user: { id: u.id, username: u.username },
        publicCoursesCount: g._count.id,
        lastCourseUpdatedAt: g._max.updatedAt.toISOString(),
        latestCourseSlug: latest.slug,
        latestCourseTitle: latest.title,
      });
    }

    // Sort: 'courses' — по числу курсов desc, при равенстве — recent.
    // 'recent' — только по дате.
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

  /**
   * KS-1918: инвалидирует кеш `/lessons/user-courses/authors`. Ключи
   * формы `lessons:authors:<sort>:<limit>:<offset>` —
   * `cache.invalidate('lessons:authors:*')` сделает SCAN+DEL.
   *
   * Вызывается после мутаций, которые могут поменять список авторов
   * с публичными курсами или агрегаты по ним: создание публичного
   * курса, любое `update` (в т.ч. с `isPublic`-toggle) и `delete`.
   */
  private async invalidateAuthorsCache(): Promise<void> {
    await this.cache.invalidate(`${AUTHORS_CACHE_PREFIX}:*`);
  }

  /**
   * KS-1889: «Курсы, которые я прохожу». Возвращает чужие курсы
   * (`course.ownerId !== userId`), у которых у текущего пользователя
   * есть запись `UserCoursePlayProgress`. Прогресс вшит прямо в DTO,
   * чтобы у фронта не было второго запроса на бейдж/прогресс-бар.
   *
   * Один запрос, без N+1: `userCoursePlayProgress.findMany` с
   * `include: { course }`. Фильтр `ownerId: { not: userId }` отсекает
   * собственные курсы автора, прошедшего свой же курс.
   *
   * `stats` намеренно НЕ кладём — это студенческая вкладка, авторские
   * метрики прохождений не должны утекать через неё (см. KS-1885).
   *
   * Сортировка `lastActivityAt DESC` — наверху недавние, сценарий
   * «вернуться к тому, что недавно проходил».
   *
   * Приватные курсы могут попасть в выборку, если автор перевёл
   * публичный курс в приватный после того, как студент его начал —
   * запись `UserCoursePlayProgress` не удаляется при изменении
   * `isPublic`. Возвращаем такие курсы как есть; фронт сам решит,
   * показывать ли пометку «теперь приватный».
   */
  async listEnrolled(
    userId: string,
  ): Promise<UserEnrolledCoursesListResponse> {
    const rows = await this.prisma.userCoursePlayProgress.findMany({
      where: {
        userId,
        course: { ownerId: { not: userId } },
      },
      orderBy: { lastActivityAt: 'desc' },
      include: {
        course: {
          include: {
            _count: { select: { lessons: true } },
            // KS-1955: уроки нужны, чтобы определить «текущий» урок
            // (первый незавершённый по `order` ASC) для Hero Variant B.
            lessons: {
              orderBy: { order: 'asc' },
              select: { id: true, order: true, title: true },
            },
          },
        },
      },
    });

    // KS-1955: одним запросом подтягиваем completed-флаги по всем
    // урокам всех enrolled-курсов — без N+1.
    const allLessonIds = rows.flatMap((r) => r.course.lessons.map((l) => l.id));
    const lessonProgressByLessonId = new Map<string, { completedAt: Date | null }>();
    if (allLessonIds.length > 0) {
      const lessonRows = await this.prisma.userLessonPlayProgress.findMany({
        where: { userId, userLessonId: { in: allLessonIds } },
        select: { userLessonId: true, completedAt: true },
      });
      for (const lr of lessonRows) {
        lessonProgressByLessonId.set(lr.userLessonId, {
          completedAt: lr.completedAt,
        });
      }
    }

    return {
      data: rows.map((row): UserEnrolledCourseDto => {
        // KS-1955: первый незавершённый урок (`order` ASC).
        const lessons = row.course.lessons;
        const currentIdx = lessons.findIndex(
          (l) => lessonProgressByLessonId.get(l.id)?.completedAt == null,
        );
        const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

        return {
          ...toCourseDto(row.course), // без stats — opts не передаём
          // KS-1933/KS-1934/KS-1935: поля карточки курса (Lessons-redesign §8.1)
          // у `UserCourse` пока отсутствуют в БД — DTO-поля
          // (`coverUrl`, `difficulty`, `estimatedMinutes`, `audience/hook/outcomeI18nKey`,
          // `tags`) опциональны и здесь явно не выставляются (= undefined в JSON).
          // Когда автор пользовательских курсов получит редактор обогащения
          // (отдельная задача), маппер пробросит реальные значения.
          progress: toCoursePlayProgressDto(row, {
            currentLesson: currentLesson
              ? {
                  // У UserLesson нет slug — отдаём id (для построения
                  // URL `/lessons/my/<courseSlug>/<lessonId>`).
                  slug: currentLesson.id,
                  title: currentLesson.title,
                  order: currentIdx + 1,
                }
              : null,
          }),
        };
      }),
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

    // KS-1955: вычисляем «текущий урок» для прогресса. Уроки уже
    // загружены и отсортированы по `order` ASC. Подтягиваем completed-
    // флаги одним запросом.
    let currentLessonForProgress:
      | { slug: string; title: string; order: number }
      | null = null;
    if (progress) {
      const lessonIds = course.lessons.map((l) => l.id);
      const lessonProgressRows =
        lessonIds.length > 0
          ? await this.prisma.userLessonPlayProgress.findMany({
              where: { userId, userLessonId: { in: lessonIds } },
              select: { userLessonId: true, completedAt: true },
            })
          : [];
      const completedSet = new Set(
        lessonProgressRows
          .filter((lp) => lp.completedAt != null)
          .map((lp) => lp.userLessonId),
      );
      const currentIdx = course.lessons.findIndex((l) => !completedSet.has(l.id));
      if (currentIdx >= 0) {
        const cl = course.lessons[currentIdx];
        currentLessonForProgress = {
          slug: cl.id, // у UserLesson нет slug — отдаём id для URL
          title: cl.title,
          order: currentIdx + 1,
        };
      }
    }

    return {
      course: toCourseDto(course, { stats }),
      lessons: course.lessons.map(toLessonDto),
      progress: progress
        ? toCoursePlayProgressDto(progress, {
            currentLesson: currentLessonForProgress,
          })
        : null,
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
      // KS-1918: создание публичного курса добавляет автора в
      // listAuthors-выборку (если у него их не было) или поднимает
      // counter. По умолчанию `isPublic=false` — только условный вызов.
      if (created.isPublic) {
        await this.invalidateAuthorsCache().catch(() => {});
      }
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
    // KS-1918: при изменении любого поля курса (особенно `isPublic`,
    // `title` — последний теасер из listAuthors) инвалидируем кеш
    // авторов. Делаем безусловно — мутации курсов не частые, перебдеть
    // безопаснее, чем разойтись с реальностью на 5 минут.
    await this.invalidateAuthorsCache().catch(() => {});
    return toCourseDto(updated);
  }

  async delete(ownerId: string, courseId: string): Promise<void> {
    await this.assertOwner(ownerId, courseId);
    await this.prisma.userCourse.delete({ where: { id: courseId } });
    // KS-1918: удаление публичного курса может убрать последнего
    // публичного курса автора → автор должен пропасть из листинга.
    await this.invalidateAuthorsCache().catch(() => {});
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

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Clamp + integer-coerce. Используется как defensive-проверка лимитов
 * в сервисе, дополнительно к ValidationPipe DTO query-параметров.
 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
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

export function toCoursePlayProgressDto(
  row: {
    userCourseId: string;
    completedLessonsCount: number;
    startedAt: Date;
    lastActivityAt: Date;
    completedAt: Date | null;
  },
  // KS-1955: «текущий урок» вычисляется в сервисе (нужны уроки и их
  // прогрессы — за рамками одной row'ы). Если не передан — поля
  // отдадим как null (соответствует «прогресс есть, но уроков нет /
  // источник не предоставил данные» — UI рисует CTA «Открыть курс»
  // без подзаголовка).
  opts?: {
    currentLesson?: { slug: string; title: string; order: number } | null;
  },
): UserCoursePlayProgressDto {
  const cl = opts?.currentLesson ?? null;
  return {
    userCourseId: row.userCourseId,
    completedLessonsCount: row.completedLessonsCount,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
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
