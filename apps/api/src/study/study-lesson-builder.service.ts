import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserCoursesService } from '../lessons/user-courses/user-courses.service';
import { UserLessonsService } from '../lessons/user-courses/user-lessons.service';
import { StudyTemplateSeederService } from './study-template-seeder.service';
import {
  fillPlaceholders,
  RatingShelf,
  templateSlugFor,
} from './study-shelves';
import { STUDY_NOTE_LINES } from './templates/study-template-content';
import { LessonMaterial } from './material/lesson-material.types';

/**
 * KS-4910/KS-4911 / ADR-162 (решение architect,
 * /tmp/KS-4909-templates-details.md). Сборка персонального урока =
 * КЛОНИРОВАНИЕ шаблонного урока полки с подстановкой:
 * - шаблон — скрытый системный курс `study-template-<shelf>`
 *   (Course/Lesson/LessonStep, правится content через lessons/admin API);
 * - text-шаги: fillPlaceholders({{focusTheme}}, {{notes}},
 *   {{homeworkCarryOver}}, {{white}}, {{black}}, {{result}}, {{opening}});
 * - puzzle-шаг: selection заменяется темой и окном профиля;
 * - game-шаг: pgn заменяется партией пользователя; партий нет —
 *   game-шаг и text-шаги c game-плейсхолдерами пропускаются;
 * - quiz/drill/endgame_drill — копируются как есть.
 *
 * Целевой урок — в скрытом ПЕРСОНАЛЬНОМ курсе «Мои занятия»
 * (ownerId=userId, isPublic=false, ленивое создание). Плеер, прогресс,
 * SM-2 — существующий lessons-стек без изменений.
 */
@Injectable()
export class StudyLessonBuilderService {
  private readonly logger = new Logger(StudyLessonBuilderService.name);
  /** Маркер персонального курса занятий в description. */
  static readonly COURSE_MARKER = 'kingside:study-personal-course';
  /** Ротация: уроки персонального курса старше N дней удаляются (§2.2). */
  static readonly LESSON_TTL_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: UserCoursesService,
    private readonly lessons: UserLessonsService,
    private readonly templates: StudyTemplateSeederService,
  ) {}

  async buildLesson(
    userId: string,
    lang: string,
    shelf: RatingShelf,
    /** Готовое окно рейтинга пазлов (полка + адаптация — считает генератор). */
    ratingWindow: { min: number; max: number },
    material: LessonMaterial,
  ): Promise<{ lessonId: string; courseId: string; courseSlug: string; themeLabel: string }> {
    const course = await this.ensurePersonalCourse(userId, lang);
    await this.rotateOldLessons(course.id);

    const focusTheme = material.focusThemes[0] ?? shelf.priorityThemes[0] ?? 'tactics';
    const template = await this.loadTemplate(shelf.key, lang);
    const args = this.placeholderArgs(lang, focusTheme, material);

    const lesson = await this.prisma.lesson.create({
      data: {
        courseId: course.id,
        ownerId: userId,
        order: await this.nextLessonOrder(course.id),
        title: fillPlaceholders(template.title, args),
        estMinutes: 20,
        lang: lang === 'ru' ? 'ru' : 'en',
      },
    });

    const hasGame = material.gameFragments.length > 0;
    const frag = material.gameFragments[0];
    for (const step of template.steps) {
      const payload = step.payload as Record<string, unknown>;
      try {
        switch (step.type) {
          case 'text': {
            const body = String(payload.bodyMarkdown ?? '');
            if (!hasGame && this.hasGamePlaceholders(body)) continue;
            await this.lessons.addStep(
              lesson.id,
              {
                type: 'text',
                payload: { type: 'text', bodyMarkdown: fillPlaceholders(body, args) },
              },
              userId,
            );
            break;
          }
          case 'puzzle':
            await this.lessons.addStep(
              lesson.id,
              {
                type: 'puzzle',
                payload: {
                  ...payload,
                  type: 'puzzle',
                  selection: {
                    mode: 'filter',
                    themes: [focusTheme] as import('@kingside/shared').PuzzleTheme[],
                    ratingMin: Math.max(400, ratingWindow.min),
                    ratingMax: Math.min(3200, ratingWindow.max),
                    limit: 6,
                  },
                },
              },
              userId,
            );
            break;
          case 'game': {
            if (!hasGame) continue;
            await this.lessons.addStep(
              lesson.id,
              {
                type: 'game',
                payload: {
                  type: 'game',
                  sourceType: 'pgn',
                  pgn: frag.pgn,
                  meta: {
                    white: frag.white ?? undefined,
                    black: frag.black ?? undefined,
                    result: frag.result ?? undefined,
                  },
                },
              },
              userId,
            );
            break;
          }
          default:
            // quiz / drill / endgame_drill — как есть из шаблона.
            await this.lessons.addStep(
              lesson.id,
              { type: step.type as import('@kingside/shared').UserStepType, payload: payload as never },
              userId,
            );
        }
      } catch (e) {
        // Один битый шаг (PGN, лимиты) не роняет сборку урока.
        this.logger.warn(
          `template step ${step.type} skipped: ${(e as Error).message}`,
        );
      }
    }

    return {
      lessonId: lesson.id,
      courseId: course.id,
      courseSlug: course.slug,
      themeLabel: focusTheme,
    };
  }

  /**
   * Шаги шаблонного урока полки. Курс отсутствует → сидинг
   * (create-if-missing); урок нужного языка отсутствует → ru.
   */
  private async loadTemplate(
    shelfKey: string,
    lang: string,
  ): Promise<{ title: string; steps: Array<{ type: string; payload: unknown }> }> {
    await this.templates.ensureTemplate(shelfKey);
    const course = await this.prisma.course.findFirst({
      where: { slug: templateSlugFor(shelfKey), ownerId: null },
      select: { id: true },
    });
    if (!course) throw new Error(`study template course missing: ${shelfKey}`);
    const lesson =
      (await this.prisma.lesson.findFirst({
        where: { courseId: course.id, lang },
        include: { steps: { orderBy: { order: 'asc' } } },
      })) ??
      (await this.prisma.lesson.findFirst({
        where: { courseId: course.id, lang: 'ru' },
        include: { steps: { orderBy: { order: 'asc' } } },
      }));
    if (!lesson || lesson.steps.length === 0) {
      throw new Error(`study template lesson missing/empty: ${shelfKey}/${lang}`);
    }
    return {
      title: lesson.title ?? 'Study session',
      steps: lesson.steps.map((s) => ({ type: s.type, payload: s.payload })),
    };
  }

  /** Аргументы подстановки по контракту плейсхолдеров. */
  private placeholderArgs(
    lang: string,
    focusTheme: string,
    material: LessonMaterial,
  ): Record<string, string | number> {
    const noteLines = STUDY_NOTE_LINES[lang === 'ru' ? 'ru' : 'en'];
    const notes = material.notes
      .filter((n) => n.key !== 'carryOver')
      .map((n) => fillPlaceholders(noteLines[n.key] ?? '', n.args))
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join('\n');
    const carry = material.notes.find((n) => n.key === 'carryOver');
    const frag = material.gameFragments[0];
    return {
      focusTheme,
      notes,
      homeworkCarryOver: carry
        ? fillPlaceholders(noteLines.carryOver ?? '', carry.args)
        : '',
      white: frag?.white ?? '?',
      black: frag?.black ?? '?',
      result: frag?.result ?? '*',
      opening: frag?.opening ?? '—',
    };
  }

  /** text-шаг относится к партии, если содержит game-плейсхолдеры. */
  private hasGamePlaceholders(body: string): boolean {
    return /\{\{(white|black|result|opening)\}\}/.test(body);
  }

  /** Скрытый персональный курс «Мои занятия» — ленивое создание. */
  private async ensurePersonalCourse(
    userId: string,
    lang: string,
  ): Promise<{ id: string; slug: string }> {
    const existing = await this.prisma.course.findFirst({
      where: { ownerId: userId, description: StudyLessonBuilderService.COURSE_MARKER },
      select: { id: true, slug: true },
    });
    if (existing) return existing;
    const created = await this.courses.create(userId, {
      title: lang === 'ru' ? 'Мои занятия' : 'My study sessions',
      description: StudyLessonBuilderService.COURSE_MARKER,
      isPublic: false,
    });
    this.logger.log(`personal study course created for user ${userId}`);
    return { id: created.id, slug: created.slug };
  }

  /** Ротация: удаляем уроки курса старше TTL (история — в StudySession). */
  private async rotateOldLessons(courseId: string): Promise<void> {
    const threshold = new Date(
      Date.now() - StudyLessonBuilderService.LESSON_TTL_DAYS * 86_400_000,
    );
    const removed = await this.prisma.lesson.deleteMany({
      where: { courseId, createdAt: { lt: threshold } },
    });
    if (removed.count > 0) {
      this.logger.log(`rotated ${removed.count} old study lesson(s) in course ${courseId}`);
    }
  }

  private async nextLessonOrder(courseId: string): Promise<number> {
    const last = await this.prisma.lesson.findFirst({
      where: { courseId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? -1) + 1;
  }
}
