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
   */
  async listCourses(userId: string | null): Promise<CourseListResponse> {
    const courses = await this.prisma.course.findMany({
      where: { isPublished: true },
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      include: {
        _count: { select: { lessons: true } },
        // KS-1955: pre-load уроков для вычисления currentLesson; берём
        // только опубликованные и в порядке прохождения (`order` ASC,
        // в рамках одного курса `blockKey` коррелирует с `order`).
        lessons: {
          where: { isPublished: true },
          orderBy: [{ blockKey: 'asc' }, { order: 'asc' }],
          select: { id: true, slug: true, titleKey: true, order: true },
        },
      },
    });

    const courseProgressByCourseId = new Map<
      string,
      {
        startedAt: Date;
        completedAt: Date | null;
        currentLessonId: string | null;
        updatedAt: Date;
      }
    >();
    const lessonProgressByLessonId = new Map<
      string,
      { completedAt: Date | null; updatedAt: Date }
    >();

    if (userId) {
      const courseRows = await this.prisma.userCourseProgress.findMany({
        where: { userId },
      });
      for (const row of courseRows) {
        courseProgressByCourseId.set(row.courseId, {
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          currentLessonId: row.currentLessonId,
          updatedAt: row.updatedAt,
        });
      }

      // KS-1955: один батч-запрос вместо N+1 count'ов. Берём только
      // уроки публикуемых курсов из выборки выше.
      const allLessonIds = courses.flatMap((c) => c.lessons.map((l) => l.id));
      if (allLessonIds.length > 0) {
        const lessonRows = await this.prisma.userLessonProgress.findMany({
          where: { userId, lessonId: { in: allLessonIds } },
          select: {
            lessonId: true,
            completedAt: true,
            updatedAt: true,
          },
        });
        for (const row of lessonRows) {
          lessonProgressByLessonId.set(row.lessonId, {
            completedAt: row.completedAt,
            updatedAt: row.updatedAt,
          });
        }
      }
    }

    const data = courses.map((c) => {
      const courseProgress = courseProgressByCourseId.get(c.id);
      const lessons = c.lessons;

      let progressDto: CourseListItemProgress | null | undefined;
      if (!userId) {
        progressDto = undefined;
      } else if (!courseProgress) {
        progressDto = null;
      } else {
        const lessonsCompleted = lessons.filter(
          (l) => lessonProgressByLessonId.get(l.id)?.completedAt != null,
        ).length;

        // KS-1955: первый незавершённый урок по списку (lessons уже
        // отсортированы blockKey/order ASC). Если все пройдены — null.
        const currentIdx = lessons.findIndex(
          (l) => lessonProgressByLessonId.get(l.id)?.completedAt == null,
        );
        const currentLesson = currentIdx >= 0 ? lessons[currentIdx] : null;

        // KS-1955: lastActivityAt = MAX(courseProgress.updatedAt, любой
        // lessonProgress.updatedAt из этого курса). Дефолт — startedAt
        // (на случай курсов с миграции, у которых updatedAt = миг.время).
        let lastActivity = courseProgress.updatedAt;
        for (const l of lessons) {
          const lp = lessonProgressByLessonId.get(l.id);
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
        progress: progressDto,
      };
    });

    const recommendedLevel = await this.recommendLevel(userId);

    return { data, recommendedLevel: recommendedLevel?.level };
  }

  /** GET /api/lessons/courses/:slug — курс с блоками и уроками. */
  async getCourseBySlug(
    slug: string,
    userId: string | null,
  ): Promise<CourseWithLessonsResponse> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
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
      const lessonIds = course.lessons.map((l) => l.id);
      const rows = await this.prisma.userLessonProgress.findMany({
        where: {
          userId,
          lessonId: { in: lessonIds },
        },
      });
      for (const row of rows) {
        // KS-1992: count('done') в stepsState — для индикатора
        // «N/M шагов» на карточке урока. stepsState — JSONB
        // `{ stepId: 'pending'|'in_progress'|'done'|'failed'|'skipped' }`.
        const stepsState = (row.stepsState ?? {}) as Record<string, string>;
        const completedStepsCount = Object.values(stepsState).filter(
          (s) => s === 'done',
        ).length;
        lessonProgressMap.set(row.lessonId, {
          completedAt: row.completedAt,
          startedAt: row.startedAt,
          masteredAt: row.masteredAt,
          updatedAt: row.updatedAt,
          completedStepsCount,
        });
      }

      // Ближайший плановый повтор SM-2 (L-22): один LessonReview на пару
      // (userId, lessonId) — тянем `dueAt` одним запросом по всем урокам
      // текущего курса и отдаём на фронт как бейдж «К повторению».
      const reviews = await this.prisma.lessonReview.findMany({
        where: { userId, lessonId: { in: lessonIds } },
        select: { lessonId: true, dueAt: true },
      });
      for (const r of reviews) {
        reviewDueMap.set(r.lessonId, r.dueAt);
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
      const p = await this.prisma.userCourseProgress.findUnique({
        where: { userId_courseId: { userId, courseId: course.id } },
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
}
