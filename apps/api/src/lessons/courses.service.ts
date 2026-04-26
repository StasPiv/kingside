import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CourseLevel,
  CourseListResponse,
  CourseWithLessonsResponse,
  CourseLessonSummary,
  LessonKind,
  CourseRecommendationResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/lessons/courses — список опубликованных курсов.
   * Если `userId` задан — обогащаем прогресс пользователя и рекомендованный уровень
   * по `user.ratingPuzzle`.
   */
  async listCourses(userId: string | null): Promise<CourseListResponse> {
    const courses = await this.prisma.course.findMany({
      where: { isPublished: true },
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      include: { _count: { select: { lessons: true } } },
    });

    const progressByCourseId = new Map<
      string,
      {
        lessonsCompleted: number;
        startedAt: string;
        completedAt: string | null;
        currentLessonId: string | null;
      }
    >();

    if (userId) {
      const rows = await this.prisma.userCourseProgress.findMany({
        where: { userId },
      });
      for (const row of rows) {
        const completed = await this.prisma.userLessonProgress.count({
          where: {
            userId,
            completedAt: { not: null },
            lesson: { courseId: row.courseId },
          },
        });
        progressByCourseId.set(row.courseId, {
          lessonsCompleted: completed,
          startedAt: row.startedAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
          currentLessonId: row.currentLessonId,
        });
      }
    }

    const data = courses.map((c) => ({
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
      order: c.order,
      lessonCount: c._count.lessons,
      progress: userId ? progressByCourseId.get(c.id) ?? null : undefined,
    }));

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
      { completedAt: Date | null; startedAt: Date | null; masteredAt: Date | null }
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
        lessonProgressMap.set(row.lessonId, {
          completedAt: row.completedAt,
          startedAt: row.startedAt,
          masteredAt: row.masteredAt,
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
        stepCount: l._count.steps,
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
        userProgress = {
          userId: p.userId,
          courseId: p.courseId,
          startedAt: p.startedAt.toISOString(),
          completedAt: p.completedAt?.toISOString() ?? null,
          currentLessonId: p.currentLessonId,
          lessonsCompleted,
          lessonsTotal: lessons.length,
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
