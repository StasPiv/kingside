import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Sm2Service } from './sm2.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * REST-эндпоинт «К повторению сегодня» (ADR-025 §2.7).
 *
 * Запрос выборки on-demand через индекс `(userId, dueAt)` —
 * без cron-пересчёта. UI (L-22) рисует список на базе этих данных.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/reviews')
export class LessonReviewsController {
  constructor(
    private readonly sm2: Sm2Service,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/lessons/reviews/due
   *
   * Возвращает уроки, у которых `dueAt <= now()` для текущего
   * пользователя. Каждый элемент — достаточные для UI данные о
   * прогрессе и SM-2-параметрах.
   */
  @Get('due')
  async getDueReviews(@Request() req: AuthenticatedRequest): Promise<{
    data: Array<{
      lessonId: string;
      lessonSlug: string;
      courseSlug: string;
      titleI18nKey: string;
      summaryI18nKey: string;
      kind: string;
      dueAt: string;
      interval: number;
      repetitions: number;
      easiness: number;
      lastReviewedAt: string | null;
      lastQuality: number | null;
    }>;
  }> {
    const userId = req.user.id;
    const due = await this.sm2.getDueReviews(userId);
    if (due.length === 0) {
      return { data: [] };
    }

    const lessonIds = due.map((r) => r.lessonId);
    const lessons = await this.prisma.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: {
        id: true,
        slug: true,
        titleKey: true,
        summaryKey: true,
        kind: true,
        course: { select: { slug: true } },
      },
    });
    const byId = new Map(lessons.map((l) => [l.id, l]));

    const data = due
      .map((r) => {
        const lesson = byId.get(r.lessonId);
        if (!lesson) return null;
        return {
          lessonId: r.lessonId,
          lessonSlug: lesson.slug,
          courseSlug: lesson.course.slug,
          titleI18nKey: lesson.titleKey,
          summaryI18nKey: lesson.summaryKey,
          kind: lesson.kind,
          dueAt: r.dueAt.toISOString(),
          interval: r.interval,
          repetitions: r.repetitions,
          easiness: r.easiness,
          lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
          lastQuality: r.lastQuality,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { data };
  }
}
