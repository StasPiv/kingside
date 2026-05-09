import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LessonKind,
  LessonStep,
  LessonStepState,
  LessonStepType,
  LessonWithStepsResponse,
  StepPayload,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LessonsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/lessons/lessons/:id — урок с шагами + прогресс пользователя. */
  async getLessonWithSteps(
    lessonId: string,
    userId: string | null,
  ): Promise<LessonWithStepsResponse> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        steps: { orderBy: { order: 'asc' } },
      },
    });

    if (!lesson || !lesson.isPublished) {
      throw new NotFoundException('Lesson not found');
    }

    const steps: LessonStep[] = lesson.steps.map((s) => ({
      id: s.id,
      lessonId: s.lessonId,
      order: s.order,
      type: s.type as LessonStepType,
      // `payload` хранится как Json (JSONB). Shape — дискриминированный union
      // StepPayload (@kingside/shared). Валидация при вставке — через seed-линтер
      // (L-05) и API DTO (StepPayloadDto).
      payload: s.payload as unknown as StepPayload,
    }));

    let progress: LessonWithStepsResponse['progress'] = null;
    if (userId) {
      const p = await this.prisma.userLessonProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      });
      if (p) {
        progress = {
          userId: p.userId,
          lessonId: p.lessonId,
          startedAt: p.startedAt.toISOString(),
          completedAt: p.completedAt?.toISOString() ?? null,
          // score в БД — 0..100 (ADR-024 §2.1), shared-тип — 0..1; нормализуем.
          score: p.score === null ? null : p.score / 100,
          stepsState: (p.stepsState as unknown as Record<string, LessonStepState>) ?? {},
        };
      }
    }

    return {
      lesson: {
        id: lesson.id,
        courseId: lesson.courseId,
        // KS-2640 / ADR-054 Phase B: поля стали nullable; для системных
        // уроков непусты — `?? ''` защищает type-чек.
        slug: lesson.slug ?? '',
        order: lesson.order,
        kind: (lesson.kind ?? 'theory') as LessonKind,
        titleI18nKey: lesson.titleKey ?? '',
        summaryI18nKey: lesson.summaryKey ?? '',
        // KS-1980: inline-поля урока (KS-1964/KS-1965). FE приоритет
        // `title ?? t(titleI18nKey)`. В KS-1966 inline уже пробрасывался
        // через listCourses/getCourseBySlug; здесь — для LessonPage.
        title: lesson.title,
        summary: lesson.summary,
        createdAt: lesson.createdAt.toISOString(),
        updatedAt: lesson.updatedAt.toISOString(),
      },
      steps,
      progress,
    };
  }
}
