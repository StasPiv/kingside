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

    const lessonProgressMap = new Map<string, { completedAt: Date | null; startedAt: Date | null }>();
    if (userId) {
      const rows = await this.prisma.userLessonProgress.findMany({
        where: {
          userId,
          lessonId: { in: course.lessons.map((l) => l.id) },
        },
      });
      for (const row of rows) {
        lessonProgressMap.set(row.lessonId, {
          completedAt: row.completedAt,
          startedAt: row.startedAt,
        });
      }
    }

    const lessons: CourseLessonSummary[] = course.lessons.map((l) => {
      const prog = lessonProgressMap.get(l.id);
      let state: CourseLessonSummary['progressState'] = 'not_started';
      if (prog?.completedAt) state = 'completed';
      else if (prog?.startedAt) state = 'in_progress';
      return {
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
