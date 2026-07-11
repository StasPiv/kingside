import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRACTICE_ROTATION,
  StudyProfile,
  StudyTaskType,
} from './study-plan-generator.service';

/**
 * KS-4881 / ADR-160 §2.1. Сбор профиля ученика «на лету» из
 * существующих данных — отдельного «уровня» не вводим. Результат
 * сохраняется в StudySession.profile_snapshot для отладки генератора.
 *
 * Честные упрощения v1 (детализация — задача 5, трекинг):
 * - `recentThemeSolveRate` — прокси: решаемость ВСЕХ PuzzleAttempt с
 *   момента 3-го с конца занятия (связь attempt↔занятие появится в
 *   reconciliation задачи 5).
 * - Маппинг «рейтинговая полка → системный курс» — задача 6 (content);
 *   пока полка выводится из ratingPuzzle: <1300 beginner,
 *   <1700 intermediate, иначе advanced.
 */
@Injectable()
export class StudyProfileService {
  private readonly logger = new Logger(StudyProfileService.name);
  /** Тема «закрыта», когда успешность за 30 дней ≥ 65 % (§2.3). */
  private static readonly THEME_CLOSED_RATE = 65;
  /** Минимум попыток, чтобы тема считалась статистически значимой. */
  private static readonly THEME_MIN_ATTEMPTS = 10;

  constructor(private readonly prisma: PrismaService) {}

  async collect(userId: string, scheduleId: string): Promise<StudyProfile> {
    const [user, dueReviews, weakThemes, recentSessions] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ratingPuzzle: true },
      }),
      this.prisma.lessonReview.findMany({
        where: { userId, dueAt: { lte: new Date() } },
        orderBy: { dueAt: 'asc' },
        take: 4,
        select: { lessonId: true },
      }),
      this.weakThemes(userId),
      this.prisma.studySession.findMany({
        where: { scheduleId, status: { in: ['completed', 'expired'] } },
        orderBy: { scheduledAt: 'desc' },
        take: 3,
        include: { tasks: true },
      }),
    ]);

    const [nextLesson, practiceLastUsedAt] = await Promise.all([
      this.nextLesson(userId, user.ratingPuzzle),
      this.practiceLastUsedAt(userId),
    ]);

    return {
      ratingPuzzle: user.ratingPuzzle,
      dueReviewLessonIds: dueReviews.map((r) => r.lessonId),
      weakThemes,
      nextLesson,
      recentThemeSolveRate: await this.recentSolveRate(userId, recentSessions),
      recentCompletionRates: recentSessions.map((s) => {
        if (s.tasks.length === 0) return 0;
        return s.tasks.filter((t) => t.status === 'done').length / s.tasks.length;
      }),
      practiceLastUsedAt,
      carryOver: this.carryOver(recentSessions),
    };
  }

  /** Слабые темы за 30 дней: attempted ≥ 10, rate < 65, худшая первой. */
  private async weakThemes(
    userId: string,
  ): Promise<Array<{ theme: string; attempted: number; rate: number }>> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const raw = await this.prisma.$queryRaw<
      Array<{ themes: string; total: bigint; solved: bigint }>
    >`
      SELECT p.themes, COUNT(*)::bigint AS total,
             SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint AS solved
      FROM puzzle_attempts pa
      JOIN puzzles p ON pa.puzzle_id = p.id
      WHERE pa.user_id = ${userId}::uuid
        AND pa.created_at >= ${since}
        AND p.themes != ''
      GROUP BY p.themes
    `;
    const map = new Map<string, { attempted: number; solved: number }>();
    for (const row of raw) {
      for (const theme of row.themes.split(' ').filter(Boolean)) {
        const e = map.get(theme) ?? { attempted: 0, solved: 0 };
        e.attempted += Number(row.total);
        e.solved += Number(row.solved);
        map.set(theme, e);
      }
    }
    return Array.from(map.entries())
      .map(([theme, s]) => ({
        theme,
        attempted: s.attempted,
        rate: s.attempted > 0 ? Math.round((s.solved / s.attempted) * 100) : 0,
      }))
      .filter(
        (t) =>
          t.attempted >= StudyProfileService.THEME_MIN_ATTEMPTS &&
          t.rate < StudyProfileService.THEME_CLOSED_RATE,
      )
      .sort((a, b) => a.rate - b.rate);
  }

  /**
   * Следующий урок: активный курс (последний незавершённый
   * UserCourseProgress) → первый незавершённый опубликованный урок;
   * нет активного курса → системный курс рейтинговой полки.
   */
  private async nextLesson(
    userId: string,
    ratingPuzzle: number,
  ): Promise<StudyProfile['nextLesson']> {
    const progress = await this.prisma.userCourseProgress.findFirst({
      where: { userId, completedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { course: { select: { id: true, slug: true } } },
    });

    let course = progress?.course ?? null;
    if (!course) {
      const shelf = ratingPuzzle < 1300 ? 'beginner' : ratingPuzzle < 1700 ? 'intermediate' : 'advanced';
      course = await this.prisma.course.findFirst({
        where: { ownerId: null, isPublished: true, level: shelf },
        orderBy: { createdAt: 'asc' },
        select: { id: true, slug: true },
      });
    }
    if (!course) return null;
    const courseId = course.id;

    const completed = await this.prisma.userLessonProgress.findMany({
      where: { userId, completedAt: { not: null }, lesson: { courseId } },
      select: { lessonId: true },
    });
    const done = new Set(completed.map((c) => c.lessonId));
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, isPublished: true, parentLessonId: null },
      orderBy: { order: 'asc' },
      select: { id: true, estMinutes: true },
    });
    const next = lessons.find((l) => !done.has(l.id));
    return next
      ? {
          lessonId: next.id,
          courseId,
          courseSlug: course.slug,
          estMinutes: next.estMinutes,
        }
      : null;
  }

  /**
   * Прокси решаемости (§2.3): solved/total PuzzleAttempt с момента
   * самого раннего из последних 3 занятий. < 10 попыток → null.
   */
  private async recentSolveRate(
    userId: string,
    recentSessions: Array<{ scheduledAt: Date }>,
  ): Promise<number | null> {
    if (recentSessions.length === 0) return null;
    const since = recentSessions[recentSessions.length - 1].scheduledAt;
    const [total, solved] = await Promise.all([
      this.prisma.puzzleAttempt.count({
        where: { userId, createdAt: { gte: since } },
      }),
      this.prisma.puzzleAttempt.count({
        where: { userId, createdAt: { gte: since }, solved: true },
      }),
    ]);
    if (total < 10) return null;
    return Math.round((solved / total) * 100);
  }

  /** Момент последнего назначения каждого типа практики. */
  private async practiceLastUsedAt(
    userId: string,
  ): Promise<Partial<Record<StudyTaskType, Date>>> {
    const rows = await this.prisma.studyTask.findMany({
      where: {
        type: { in: PRACTICE_ROTATION },
        session: { userId },
      },
      select: { type: true, session: { select: { scheduledAt: true } } },
      orderBy: { session: { scheduledAt: 'desc' } },
      take: 50,
    });
    const result: Partial<Record<StudyTaskType, Date>> = {};
    for (const row of rows) {
      const t = row.type as StudyTaskType;
      if (!result[t]) result[t] = row.session.scheduledAt;
    }
    return result;
  }

  /**
   * Перенос из ПОСЛЕДНЕГО занятия, если оно expired (§2.3): незакрытые
   * SM-2 и тема. Долг больше одного занятия не накапливается — смотрим
   * только самое свежее.
   */
  private carryOver(
    recentSessions: Array<{
      status: string;
      tasks: Array<{ type: string; status: string; params: unknown }>;
    }>,
  ): StudyProfile['carryOver'] {
    const last = recentSessions[0];
    if (!last || last.status !== 'expired') {
      return { sm2LessonIds: [], theme: null };
    }
    let sm2LessonIds: string[] = [];
    let theme: string | null = null;
    for (const task of last.tasks) {
      if (task.status === 'done') continue;
      const params = (task.params ?? {}) as Record<string, unknown>;
      if (task.type === 'sm2_review' && Array.isArray(params.lessonIds)) {
        sm2LessonIds = params.lessonIds as string[];
      }
      if (task.type === 'puzzle_theme' && typeof params.theme === 'string') {
        theme = params.theme;
      }
    }
    return { sm2LessonIds, theme };
  }
}
