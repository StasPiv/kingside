import { Injectable } from '@nestjs/common';
import type {
  ActiveCourseDto,
  ActiveCoursesResponse,
  ActiveEnrolledCourseDto,
  ActiveSystemCourseDto,
  CourseLevel,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-1937 (Lessons-redesign B-5).
 *
 * Один запрос вместо `listCourses` + `listEnrolled` для Hero и
 * `/lessons/my-active`. Возвращает только реально активные курсы
 * пользователя из двух источников:
 *  - системных (`UserCourseProgress` где `completedAt = null`),
 *  - enrolled-чужих пользовательских (`UserCoursePlayProgress` где
 *    `completedAt = null` и `course.ownerId != userId`).
 *
 * Сортировка — `lastActivityAt` DESC (свежее наверху).
 *
 * Кастомные собственные курсы автора в выборку не попадают (см. §3.3
 * концепта KS-1931): автор не «проходит» свой курс — это редактура,
 * не обучение.
 */
@Injectable()
export class ActiveCoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveCourses(userId: string): Promise<ActiveCoursesResponse> {
    const [systemItems, enrolledItems] = await Promise.all([
      this.collectActiveSystem(userId),
      this.collectActiveEnrolled(userId),
    ]);

    const data: ActiveCourseDto[] = [...systemItems, ...enrolledItems].sort(
      (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    );

    return { data };
  }

  // ─── System courses ───────────────────────────────────────────────

  private async collectActiveSystem(
    userId: string,
  ): Promise<ActiveSystemCourseDto[]> {
    // 1. Активные UserCourseProgress (completedAt == null) сразу с
    //    подгрузкой курса и его уроков — нужно, чтобы вычислить
    //    currentLesson и сделать DTO без второго round-trip'а.
    const progresses = await this.prisma.userCourseProgress.findMany({
      where: { userId, completedAt: null },
      include: {
        course: {
          include: {
            _count: { select: { lessons: true } },
            lessons: {
              where: { isPublished: true },
              orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
              select: { id: true, slug: true, title: true, titleKey: true, order: true },
            },
          },
        },
      },
    });
    if (progresses.length === 0) return [];

    // Отфильтровываем неопубликованные курсы — на проде их быть не
    // должно, но защищаемся от seed'ов с draft'ами в dev. Прогресс
    // может остаться и на снятом с публикации курсе.
    const visible = progresses.filter((p) => p.course.isPublished);
    if (visible.length === 0) return [];

    // 2. Один батч-запрос UserLessonProgress для всех уроков всех
    //    активных курсов — без N+1.
    const allLessonIds = visible.flatMap((p) => p.course.lessons.map((l) => l.id));
    const lessonProgressByLessonId = new Map<
      string,
      { completedAt: Date | null; updatedAt: Date }
    >();
    if (allLessonIds.length > 0) {
      const rows = await this.prisma.userLessonProgress.findMany({
        where: { userId, lessonId: { in: allLessonIds } },
        select: { lessonId: true, completedAt: true, updatedAt: true },
      });
      for (const r of rows) {
        lessonProgressByLessonId.set(r.lessonId, {
          completedAt: r.completedAt,
          updatedAt: r.updatedAt,
        });
      }
    }

    return visible.map((p): ActiveSystemCourseDto => {
      const c = p.course;
      const lessons = c.lessons;

      const lessonsCompleted = lessons.filter(
        (l) => lessonProgressByLessonId.get(l.id)?.completedAt != null,
      ).length;

      const currentIdx = lessons.findIndex(
        (l) => lessonProgressByLessonId.get(l.id)?.completedAt == null,
      );
      const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

      // lastActivityAt = MAX(courseProgress.updatedAt, любой
      // lessonProgress.updatedAt из этого курса).
      let lastActivity = p.updatedAt;
      for (const l of lessons) {
        const lp = lessonProgressByLessonId.get(l.id);
        if (lp && lp.updatedAt > lastActivity) {
          lastActivity = lp.updatedAt;
        }
      }

      return {
        kind: 'system',
        id: c.id,
        slug: c.slug,
        level: c.level as CourseLevel,
        // KS-2640 / ADR-054 Phase B: поля nullable в БД; в этой ветке
        // (`kind: 'system'`) гарантировано NOT NULL — даём `?? ''` как
        // защита-нo-op для типов.
        titleI18nKey: c.titleKey ?? '',
        descriptionI18nKey: c.descriptionKey ?? '',
        coverUrl: c.coverUrl,
        difficulty: (c.difficulty ?? 2) as 1 | 2 | 3,
        estimatedMinutes: c.estimatedMinutes,
        audienceI18nKey: c.audienceI18nKey,
        hookI18nKey: c.hookI18nKey,
        outcomeI18nKey: c.outcomeI18nKey,
        tags: c.tags,
        // KS-1964/KS-1966 (Admin API B-4): inline-поля курса. FE приоритет
        // над i18n-ключами; null здесь = нет inline → UI берёт *I18nKey.
        title: c.title,
        description: c.description,
        audience: c.audience,
        hook: c.hook,
        outcome: c.outcome,
        lessonCount: c._count.lessons,
        lessonsCompleted,
        lastActivityAt: lastActivity.toISOString(),
        currentLessonSlug: currentLesson?.slug ?? null,
        // KS-2148: inline title — UI использует если *I18nKey отсутствует
        // в translation.json (был fallback на slug → видно сырой
        // `mate-bishop-knight` вместо «Мат слоном и конём»).
        currentLessonTitle: currentLesson?.title ?? null,
        currentLessonTitleI18nKey: currentLesson?.titleKey ?? null,
        currentLessonOrder: currentLesson ? currentIdx + 1 : null,
        // KS-2037: порядок блоков курса (см. `Course.blockOrder`).
        blockOrder: c.blockOrder,
      };
    });
  }

  // ─── Enrolled (custom-foreign) courses ───────────────────────────

  private async collectActiveEnrolled(
    userId: string,
  ): Promise<ActiveEnrolledCourseDto[]> {
    // KS-2649 / Phase E3. Переключено на единую `userCourseProgress`
    // (системная таблица; покрывает и системные, и пользовательские
    // курсы). Фильтр `course.ownerId IS NOT NULL AND ownerId != userId`
    // отсекает системные и собственные курсы автора.
    const progresses = await this.prisma.userCourseProgress.findMany({
      where: {
        userId,
        completedAt: null,
        course: {
          AND: [
            { ownerId: { not: null } },
            { ownerId: { not: userId } },
          ],
        },
      },
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
    if (progresses.length === 0) return [];

    const allLessonIds = progresses.flatMap((p) =>
      p.course.lessons.map((l) => l.id),
    );
    const completedSet = new Set<string>();
    if (allLessonIds.length > 0) {
      const rows = await this.prisma.userLessonProgress.findMany({
        where: { userId, lessonId: { in: allLessonIds } },
        select: { lessonId: true, completedAt: true },
      });
      for (const r of rows) {
        if (r.completedAt != null) completedSet.add(r.lessonId);
      }
    }

    return progresses.map((p): ActiveEnrolledCourseDto => {
      const c = p.course;
      const lessons = c.lessons;

      const currentIdx = lessons.findIndex((l) => !completedSet.has(l.id));
      const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

      // KS-2649: completedLessonsCount теперь считаем on-demand из
      // `completedSet` — counter в системной таблице не хранится.
      const lessonsCompleted = lessons.filter((l) =>
        completedSet.has(l.id),
      ).length;

      return {
        kind: 'enrolled',
        id: c.id,
        slug: c.slug,
        title: c.title ?? '',
        description: c.description,
        ownerId: c.ownerId ?? '',
        lessonCount: c._count.lessons,
        lessonsCompleted,
        // `lastActivityAt` ↔ `updatedAt` системного прогресса.
        lastActivityAt: p.updatedAt.toISOString(),
        currentLessonSlug: currentLesson?.id ?? null,
        currentLessonTitle: currentLesson?.title ?? null,
        currentLessonOrder: currentLesson ? currentIdx + 1 : null,
      };
    });
  }
}
