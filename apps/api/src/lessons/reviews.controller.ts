import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import type { ReviewsDueResponse, ReviewDueItem } from '@kingside/shared';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Sm2Service } from './sm2.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * REST-эндпоинт «К повторению сегодня» (ADR-025 §2.7, L-22).
 *
 * Запрос выборки on-demand через индекс `(userId, dueAt)` — без cron-пересчёта.
 * UI повторений (KS-1799) рисует список строго по shape'у `ReviewDueItem`
 * из `@kingside/shared`, чтобы не было расхождений контрактов.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/reviews')
export class LessonReviewsController {
  constructor(
    private readonly sm2: Sm2Service,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/lessons/reviews/due — возвращает `ReviewsDueResponse`.
   *
   * Порядок элементов — по `dueAt ASC` (самые «просроченные» — первыми).
   */
  @Get('due')
  async getDueReviews(@Request() req: AuthenticatedRequest): Promise<ReviewsDueResponse> {
    const userId = req.user.id;
    const due = await this.sm2.getDueReviews(userId);
    if (due.length === 0) {
      return { items: [] };
    }

    const lessonIds = due.map((r) => r.lessonId);
    const lessons = await this.prisma.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: {
        id: true,
        slug: true,
        title: true, // KS-2148: inline-заголовок (KS-1964)
        titleKey: true,
        course: { select: { slug: true, title: true, titleKey: true } },
      },
    });
    const byId = new Map(lessons.map((l) => [l.id, l]));

    const items: ReviewDueItem[] = due
      .map((r): ReviewDueItem | null => {
        const lesson = byId.get(r.lessonId);
        if (!lesson) return null;
        return {
          courseSlug: lesson.course.slug,
          // KS-2148: inline title — UI fallback в порядке title → i18nKey → slug
          courseTitle: lesson.course.title ?? null,
          courseTitleI18nKey: lesson.course.titleKey,
          lessonSlug: lesson.slug,
          lessonTitle: lesson.title ?? null,
          lessonTitleI18nKey: lesson.titleKey,
          dueAt: r.dueAt.toISOString(),
          lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
          intervalDays: r.interval,
        };
      })
      .filter((x): x is ReviewDueItem => x !== null);

    return { items };
  }
}
