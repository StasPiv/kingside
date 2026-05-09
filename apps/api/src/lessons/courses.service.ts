import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CourseLevel,
  CourseListResponse,
  CourseListItem,
  CourseWithLessonsResponse,
  CourseLessonSummary,
  LessonKind,
  CourseRecommendationResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

// KS-1955: shape поля `progress` в `CourseListItem` (inline в shared-типе).
type CourseListItemProgress = NonNullable<CourseListItem['progress']>;

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/lessons/courses — список опубликованных курсов.
   * Если `userId` задан — обогащаем прогресс пользователя и рекомендованный уровень
   * по `user.ratingPuzzle`.
   *
   * KS-1955: для каждого курса с прогрессом отдаём `lastActivityAt`
   * (MAX по `UserCourseProgress.updatedAt` и `UserLessonProgress.updatedAt`)
   * и `currentLesson*` (первый незавершённый урок по `order` ASC) —
   * нужно для Hero Variant B на странице «Уроки».
   *
   * KS-2095: фильтр по `lang` (RU/EN). KS-2101: язык берётся из
   * `User.locale` (PATCH /users/me/settings) — query/header игнорируются,
   * source of truth — настройка профиля. Для anonymous пользователей —
   * fallback 'ru'.
   * Прогресс хранится по `parentCourseId` (root) — переключение языка
   * не сбрасывает прогресс пользователя.
   */
  async listCourses(userId: string | null): Promise<CourseListResponse> {
    const lang = await this.resolveUserLocale(userId);
    const courses = await this.prisma.course.findMany({
      where: { isPublished: true, lang },
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      include: {
        _count: { select: { lessons: true } },
        // KS-1955: pre-load уроков для вычисления currentLesson; берём
        // только опубликованные и в порядке прохождения (`order` ASC,
        // в рамках одного курса `blockKey` коррелирует с `order`).
        lessons: {
          where: { isPublished: true },
          orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
          select: {
            id: true,
            slug: true,
            title: true, // KS-2148: inline-заголовок (KS-1964)
            titleKey: true,
            order: true,
            parentLessonId: true,
          },
        },
      },
    });

    // KS-2095: rootId = parentCourseId ?? id. Прогресс хранится только по
    // root-курсу — переключение языка не сбрасывает прогресс.
    const courseProgressByRootId = new Map<
      string,
      {
        startedAt: Date;
        completedAt: Date | null;
        currentLessonId: string | null;
        updatedAt: Date;
      }
    >();
    const lessonProgressByRootId = new Map<
      string,
      { completedAt: Date | null; updatedAt: Date }
    >();

    if (userId) {
      const rootCourseIds = courses.map((c) => c.parentCourseId ?? c.id);
      const courseRows = await this.prisma.userCourseProgress.findMany({
        where: { userId, courseId: { in: rootCourseIds } },
      });
      for (const row of courseRows) {
        courseProgressByRootId.set(row.courseId, {
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          currentLessonId: row.currentLessonId,
          updatedAt: row.updatedAt,
        });
      }

      // KS-1955 + KS-2095: lessons тоже резолвим к root для прогресса.
      const allLessonRootIds = courses.flatMap((c) =>
        c.lessons.map((l) => l.parentLessonId ?? l.id),
      );
      if (allLessonRootIds.length > 0) {
        const lessonRows = await this.prisma.userLessonProgress.findMany({
          where: { userId, lessonId: { in: allLessonRootIds } },
          select: {
            lessonId: true,
            completedAt: true,
            updatedAt: true,
          },
        });
        for (const row of lessonRows) {
          lessonProgressByRootId.set(row.lessonId, {
            completedAt: row.completedAt,
            updatedAt: row.updatedAt,
          });
        }
      }
    }

    /** KS-2095: helper — root-id урока. */
    const lessonRootId = (l: { id: string; parentLessonId: string | null }) =>
      l.parentLessonId ?? l.id;

    const data = courses.map((c) => {
      const rootCourseId = c.parentCourseId ?? c.id;
      const courseProgress = courseProgressByRootId.get(rootCourseId);
      const lessons = c.lessons;

      let progressDto: CourseListItemProgress | null | undefined;
      if (!userId) {
        progressDto = undefined;
      } else if (!courseProgress) {
        progressDto = null;
      } else {
        const lessonsCompleted = lessons.filter(
          (l) => lessonProgressByRootId.get(lessonRootId(l))?.completedAt != null,
        ).length;

        // KS-1955: первый незавершённый урок по списку (lessons уже
        // отсортированы blockKey/order ASC). Если все пройдены — null.
        const currentIdx = lessons.findIndex(
          (l) => lessonProgressByRootId.get(lessonRootId(l))?.completedAt == null,
        );
        const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

        // KS-1955: lastActivityAt = MAX(courseProgress.updatedAt, любой
        // lessonProgress.updatedAt из этого курса). Дефолт — startedAt
        // (на случай курсов с миграции, у которых updatedAt = миг.время).
        let lastActivity = courseProgress.updatedAt;
        for (const l of lessons) {
          const lp = lessonProgressByRootId.get(lessonRootId(l));
          if (lp && lp.updatedAt > lastActivity) {
            lastActivity = lp.updatedAt;
          }
        }

        progressDto = {
          lessonsCompleted,
          startedAt: courseProgress.startedAt.toISOString(),
          completedAt: courseProgress.completedAt?.toISOString() ?? null,
          currentLessonId: courseProgress.currentLessonId,
          lastActivityAt: lastActivity.toISOString(),
          currentLessonSlug: currentLesson?.slug ?? null,
          // KS-2148: inline-заголовок (UI fallback в порядке title → i18nKey → slug).
          currentLessonTitle: currentLesson?.title ?? null,
          currentLessonTitleI18nKey: currentLesson?.titleKey ?? null,
          currentLessonOrder: currentLesson ? currentIdx + 1 : null,
        };
      }

      return {
        id: c.id,
        slug: c.slug,
        level: c.level as CourseLevel,
        titleI18nKey: c.titleKey,
        descriptionI18nKey: c.descriptionKey,
        // KS-1933/KS-1934/KS-1935: поля карточки курса (Lessons-redesign §8.1).
        coverUrl: c.coverUrl,
        difficulty: c.difficulty as 1 | 2 | 3,
        estimatedMinutes: c.estimatedMinutes,
        audienceI18nKey: c.audienceI18nKey,
        hookI18nKey: c.hookI18nKey,
        outcomeI18nKey: c.outcomeI18nKey,
        tags: c.tags,
        // KS-1964/KS-1966 (Admin API B-4): inline-поля. Передаём как есть;
        // FE сам делает `inline ?? t(i18nKey)`. null здесь = нет inline,
        // UI показывает результат i18n-ключа.
        title: c.title,
        description: c.description,
        audience: c.audience,
        hook: c.hook,
        outcome: c.outcome,
        order: c.order,
        lessonCount: c._count.lessons,
        // KS-2037: порядок блоков курса (фронт берёт отсюда вместо
        // хардкода `BLOCK_ORDER`). Возвращаем всегда — может быть пустым.
        blockOrder: c.blockOrder,
        progress: progressDto,
      };
    });

    const recommendedLevel = await this.recommendLevel(userId);

    return { data, recommendedLevel: recommendedLevel?.level };
  }

  /**
   * GET /api/lessons/courses/:slug — курс с блоками и уроками.
   * KS-2095/KS-2101: lang берётся из настроек профиля
   * (`User.locale`, default 'ru' для anonymous). Если запрошенный slug
   * существует только на другом языке — 404.
   */
  async getCourseBySlug(
    slug: string,
    userId: string | null,
  ): Promise<CourseWithLessonsResponse> {
    const lang = await this.resolveUserLocale(userId);
    // KS-2639 / ADR-054 §3.1 п.5. После Phase A уникальность `(slug, lang)`
    // обеспечена partial-unique индексом `WHERE owner_id IS NULL` —
    // compound `slug_lang` в Prisma-типе больше нет. Через `findFirst`
    // явно ограничиваемся системным namespace (`ownerId: null`).
    const course = await this.prisma.course.findFirst({
      where: { slug, lang, ownerId: null },
      include: {
        lessons: {
          where: { isPublished: true },
          orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
          include: { _count: { select: { steps: true } } },
        },
      },
    });

    if (!course || !course.isPublished) {
      throw new NotFoundException('Course not found');
    }

    // KS-2095: rootCourseId — для прогресса. Если этот вариант сам root,
    // parentCourseId IS NULL → используем его id.
    const rootCourseId = course.parentCourseId ?? course.id;
    /** KS-2095: helper — root-id урока. */
    const lessonRootId = (l: { id: string; parentLessonId: string | null }) =>
      l.parentLessonId ?? l.id;

    const lessonProgressMap = new Map<
      string,
      {
        completedAt: Date | null;
        startedAt: Date | null;
        masteredAt: Date | null;
        updatedAt: Date;
        completedStepsCount: number;
      }
    >();
    const reviewDueMap = new Map<string, Date>();
    if (userId) {
      // KS-2095: прогресс/SM-2 хранится по root-id урока. Сопоставляем
      // root-id обратно к локальному id текущего языкового варианта.
      const localToRoot = new Map<string, string>();
      for (const l of course.lessons) {
        localToRoot.set(l.id, lessonRootId(l));
      }
      const rootLessonIds = [...new Set(localToRoot.values())];
      const rows = await this.prisma.userLessonProgress.findMany({
        where: {
          userId,
          lessonId: { in: rootLessonIds },
        },
      });
      const progressByRoot = new Map<
        string,
        {
          completedAt: Date | null;
          startedAt: Date | null;
          masteredAt: Date | null;
          updatedAt: Date;
          completedStepsCount: number;
        }
      >();
      for (const row of rows) {
        // KS-1992: count('done') в stepsState — для индикатора
        // «N/M шагов» на карточке урока. stepsState — JSONB
        // `{ stepId: 'pending'|'in_progress'|'done'|'failed'|'skipped' }`.
        const stepsState = (row.stepsState ?? {}) as Record<string, string>;
        const completedStepsCount = Object.values(stepsState).filter(
          (s) => s === 'done',
        ).length;
        progressByRoot.set(row.lessonId, {
          completedAt: row.completedAt,
          startedAt: row.startedAt,
          masteredAt: row.masteredAt,
          updatedAt: row.updatedAt,
          completedStepsCount,
        });
      }
      for (const [localId, rootId] of localToRoot) {
        const p = progressByRoot.get(rootId);
        if (p) lessonProgressMap.set(localId, p);
      }

      // Ближайший плановый повтор SM-2 (L-22): один LessonReview на пару
      // (userId, lessonId) — тянем `dueAt` одним запросом по всем урокам
      // текущего курса и отдаём на фронт как бейдж «К повторению».
      const reviews = await this.prisma.lessonReview.findMany({
        where: { userId, lessonId: { in: rootLessonIds } },
        select: { lessonId: true, dueAt: true },
      });
      const reviewByRoot = new Map<string, Date>();
      for (const r of reviews) reviewByRoot.set(r.lessonId, r.dueAt);
      for (const [localId, rootId] of localToRoot) {
        const due = reviewByRoot.get(rootId);
        if (due) reviewDueMap.set(localId, due);
      }
    }

    const lessons: CourseLessonSummary[] = course.lessons.map((l) => {
      const prog = lessonProgressMap.get(l.id);
      let state: CourseLessonSummary['progressState'] = 'not_started';
      if (prog?.completedAt) state = 'completed';
      else if (prog?.startedAt) state = 'in_progress';
      const summary: CourseLessonSummary = {
        id: l.id,
        slug: l.slug,
        order: l.order,
        blockKey: l.blockKey,
        kind: l.kind as LessonKind,
        titleI18nKey: l.titleKey,
        summaryI18nKey: l.summaryKey,
        // KS-1964/KS-1966 (Admin API B-4): inline-поля урока. FE
        // приоритет: `lesson.title ?? t(lesson.titleI18nKey)`.
        title: l.title,
        summary: l.summary,
        stepCount: l._count.steps,
        // KS-1992: для анонима / без прогресса — 0; для урока с
        // записью прогресса — count(stepsState[*] === 'done').
        completedStepsCount: prog?.completedStepsCount ?? 0,
        progressState: state,
      };
      // SM-2 поля (L-22): заполняем только для авторизованных пользователей;
      // для анонимов оставляем `undefined`, чтобы не засорять payload.
      if (userId) {
        summary.masteredAt = prog?.masteredAt?.toISOString() ?? null;
        const due = reviewDueMap.get(l.id);
        summary.dueAt = due ? due.toISOString() : null;
      }
      return summary;
    });

    let userProgress = null;
    if (userId) {
      // KS-2095: прогресс хранится по root-id курса.
      const p = await this.prisma.userCourseProgress.findUnique({
        where: { userId_courseId: { userId, courseId: rootCourseId } },
      });
      if (p) {
        const lessonsCompleted = lessons.filter((l) => l.progressState === 'completed').length;

        // KS-1955: первый незавершённый урок по списку (course.lessons
        // отсортированы blockKey/order ASC). null, если все пройдены.
        const currentIdx = course.lessons.findIndex(
          (l) => lessonProgressMap.get(l.id)?.completedAt == null,
        );
        const currentLessonRow = currentIdx >= 0 ? course.lessons[currentIdx] : null;

        // KS-1955: lastActivityAt = MAX(courseProgress.updatedAt, любой
        // lessonProgress.updatedAt из этого курса).
        let lastActivity = p.updatedAt;
        for (const lp of lessonProgressMap.values()) {
          if (lp.updatedAt > lastActivity) {
            lastActivity = lp.updatedAt;
          }
        }

        userProgress = {
          userId: p.userId,
          courseId: p.courseId,
          startedAt: p.startedAt.toISOString(),
          completedAt: p.completedAt?.toISOString() ?? null,
          currentLessonId: p.currentLessonId,
          lessonsCompleted,
          lessonsTotal: lessons.length,
          lastActivityAt: lastActivity.toISOString(),
          currentLessonSlug: currentLessonRow?.slug ?? null,
          // KS-2148: inline title рядом с i18nKey.
          currentLessonTitle: currentLessonRow?.title ?? null,
          currentLessonTitleI18nKey: currentLessonRow?.titleKey ?? null,
          currentLessonOrder: currentLessonRow ? currentIdx + 1 : null,
        };
      }
    }

    return {
      course: {
        id: course.id,
        slug: course.slug,
        level: course.level as CourseLevel,
        titleI18nKey: course.titleKey,
        descriptionI18nKey: course.descriptionKey,
        // KS-1933/KS-1934/KS-1935: поля карточки курса (Lessons-redesign §8.1).
        coverUrl: course.coverUrl,
        difficulty: course.difficulty as 1 | 2 | 3,
        estimatedMinutes: course.estimatedMinutes,
        audienceI18nKey: course.audienceI18nKey,
        hookI18nKey: course.hookI18nKey,
        outcomeI18nKey: course.outcomeI18nKey,
        tags: course.tags,
        // KS-1964/KS-1966 (Admin API B-4): inline-поля. FE приоритет
        // `course.title ?? t(course.titleI18nKey)` и т. д.
        title: course.title,
        description: course.description,
        audience: course.audience,
        hook: course.hook,
        outcome: course.outcome,
        order: course.order,
        isPublished: course.isPublished,
        lessonCount: course.lessons.length,
        // KS-2037: порядок блоков курса. Снимает хардкод `BLOCK_ORDER` с фронта.
        blockOrder: course.blockOrder,
        createdAt: course.createdAt.toISOString(),
        updatedAt: course.updatedAt.toISOString(),
      },
      lessons,
      progress: userProgress,
    };
  }

  /**
   * Простая рекомендация уровня курса по `user.ratingPuzzle` (ADR-024 §2.3).
   * Никаких ML — жёсткие пороги из lessons-module.md §2.2.
   */
  async recommendLevel(userId: string | null): Promise<CourseRecommendationResponse | null> {
    if (!userId) {
      return { level: 'beginner', reason: 'default' };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });
    if (!user) {
      return { level: 'beginner', reason: 'default' };
    }
    const r = user.ratingPuzzle;
    let level: CourseLevel;
    if (r < 1200) level = 'beginner';
    else if (r < 1800) level = 'intermediate';
    else level = 'advanced';
    return { level, reason: 'rating_puzzle', ratingPuzzle: r };
  }

  /**
   * KS-2101: язык курсов берётся из настроек профиля (`User.locale`,
   * меняется через `PATCH /users/me/settings`). Whitelist 'ru' | 'en';
   * любое другое значение → 'ru' (защита, чтобы случайно не показать
   * пустой список курсов из-за чужого locale). Anonymous (userId=null)
   * → 'ru'.
   */
  private async resolveUserLocale(userId: string | null): Promise<'ru' | 'en'> {
    if (!userId) return 'ru';
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const raw = user?.locale ?? 'ru';
    return raw === 'en' ? 'en' : 'ru';
  }
}
