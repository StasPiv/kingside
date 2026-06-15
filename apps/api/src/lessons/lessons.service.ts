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

function normalizeLocale(raw?: string | null): 'ru' | 'en' | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'ru') return 'ru';
  if (trimmed === 'en') return 'en';
  return null;
}

@Injectable()
export class LessonsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * KS-4145: resolveLessonLocale — приоритет query > User.locale > 'en'
   * (см. courses.service.resolveUserLocale).
   */
  private async resolveLessonLocale(
    userId: string | null,
    queryLocale?: string | null,
  ): Promise<'ru' | 'en'> {
    const fromQuery = normalizeLocale(queryLocale);
    if (fromQuery) return fromQuery;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      const fromUser = normalizeLocale(user?.locale);
      if (fromUser) return fromUser;
    }
    return 'en';
  }

  /**
   * GET /api/lessons/lessons/:id — урок с шагами + прогресс пользователя.
   *
   * KS-4145: учитывает `?locale=`. Если запрошен иной язык, чем
   * `lesson.lang`, ищем sibling-перевод через `parentLessonId` (или
   * через детей, если запрошенный сам — root). Если перевод не
   * найден — возвращаем найденный урок как есть (fallback, чтобы не
   * ловить 404 при отсутствии перевода).
   */
  async getLessonWithSteps(
    lessonId: string,
    userId: string | null,
    queryLocale?: string | null,
  ): Promise<LessonWithStepsResponse> {
    let lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        steps: { orderBy: { order: 'asc' } },
      },
    });

    if (!lesson || !lesson.isPublished) {
      throw new NotFoundException('Lesson not found');
    }

    const targetLang = await this.resolveLessonLocale(userId, queryLocale);
    // Поиск sibling-перевода: только если lesson.lang известен и
    // отличается от запрошенного. Когда lesson.lang отсутствует
    // (фикстуры в тестах без поля или legacy-строки до KS-2095),
    // лишний запрос в БД не делаем.
    if (targetLang && lesson.lang && lesson.lang !== targetLang) {
      const rootId = lesson.parentLessonId ?? lesson.id;
      const sibling = await this.prisma.lesson.findFirst({
        where: {
          OR: [
            { id: rootId, lang: targetLang },
            { parentLessonId: rootId, lang: targetLang },
          ],
          isPublished: true,
        },
        include: { steps: { orderBy: { order: 'asc' } } },
      });
      if (sibling) lesson = sibling;
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
