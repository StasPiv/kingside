import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserCoursesService } from '../lessons/user-courses/user-courses.service';
import { UserLessonsService } from '../lessons/user-courses/user-lessons.service';
import { StudyPlanConfigService, RatingShelf } from './study-plan-config.service';
import { LessonMaterial } from './material/lesson-material.types';

/**
 * KS-4910 / ADR-162 §2.1, §4. Сборка персонального урока занятия
 * через СУЩЕСТВУЮЩИЕ сервисы уроков (in-process): скрытый персональный
 * курс «Мои занятия» (один на пользователя, ownerId=userId,
 * isPublic=false, ленивое создание) + урок с шагами:
 *   1. text — вводный (тема + наблюдения из material.notes);
 *   2. puzzle (filter) — слабая тема, окно рейтинга полки;
 *   3. game — партия пользователя с заданием самопроверки (если есть);
 *   4. drill — закрепление (по ротации полки).
 * Плеер, прогресс, SM-2 — весь lessons-стек работает без изменений.
 *
 * Тексты — ТОЛЬКО из tools/study-plan/lesson-templates.<lang>.json
 * (схема KS-4910, наполнение — content KS-4913).
 */
@Injectable()
export class StudyLessonBuilderService {
  private readonly logger = new Logger(StudyLessonBuilderService.name);
  /** Маркер персонального курса занятий в description (поиск при ленивом создании). */
  static readonly COURSE_MARKER = 'kingside:study-personal-course';
  /** Ротация: уроки персонального курса старше N дней удаляются (§2.2). */
  static readonly LESSON_TTL_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: UserCoursesService,
    private readonly lessons: UserLessonsService,
    private readonly config: StudyPlanConfigService,
  ) {}

  /**
   * Собрать урок занятия. Возвращает lessonId и slug курса (для
   * deep-link плеера `/lessons/:slug/:lessonId`).
   */
  async buildLesson(
    userId: string,
    lang: string,
    shelf: RatingShelf,
    /** Готовое окно рейтинга пазлов (полка + адаптация v1 — считает генератор). */
    ratingWindow: { min: number; max: number },
    material: LessonMaterial,
  ): Promise<{ lessonId: string; courseId: string; courseSlug: string; themeLabel: string }> {
    const course = await this.ensurePersonalCourse(userId, lang);
    await this.rotateOldLessons(course.id);

    const t = this.config.lessonTemplates(lang, shelf.key);
    const theme = material.focusThemes[0] ?? shelf.priorityThemes[0] ?? 'tactics';
    const themeLabel = theme;

    const lesson = await this.prisma.lesson.create({
      data: {
        courseId: course.id,
        ownerId: userId,
        order: await this.nextLessonOrder(course.id),
        title: this.config.fill(t.lessonTitle, { themeLabel }),
        estMinutes: 20,
        lang: lang === 'ru' ? 'ru' : 'en',
        // isPublished НЕ ставим: CHECK lessons_published_user_check
        // запрещает published у пользовательских уроков (ADR-054 E3);
        // владельцу урок виден и так.
      },
    });

    // 1. Вводный text-шаг: тема + наблюдения.
    const notes = material.notes
      .map((n) => this.config.fill(t.noteLines[n.key] ?? '', n.args))
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join('\n');
    await this.lessons.addStep(
      lesson.id,
      {
        type: 'text',
        payload: {
          type: 'text',
          bodyMarkdown:
            `## ${this.config.fill(t.introTitle, { themeLabel })}\n\n` +
            this.config.fill(t.introBody, { themeLabel, notes }) +
            `\n\n${t.homeworkNote}`,
        },
      },
      userId,
    );

    // 2. Пазлы по слабой теме — окно рейтинга полки (адаптация v1
    //    остаётся в генераторе: он передаёт готовое окно через shelf).
    await this.lessons.addStep(
      lesson.id,
      {
        type: 'puzzle',
        payload: {
          type: 'puzzle',
          selection: {
            mode: 'filter',
            // Темы приходят строками из статистики/полок; тип PuzzleTheme —
            // словарь lichess-тем, значения совпадают.
            themes: [theme] as import('@kingside/shared').PuzzleTheme[],
            ratingMin: Math.max(400, ratingWindow.min),
            ratingMax: Math.min(3200, ratingWindow.max),
            limit: 6,
          },
          minSolved: 4,
        },
      },
      userId,
    );

    // 3. Game-шаги: партии пользователя с заданием самопроверки.
    for (const frag of material.gameFragments) {
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
      ).catch((e: Error) => {
        // Битый PGN одной партии не должен ронять сборку урока.
        this.logger.warn(`game step skipped: ${e.message}`);
      });
      // Задание самопроверки — отдельным text-шагом после доски.
      await this.lessons.addStep(
        lesson.id,
        {
          type: 'text',
          payload: {
            type: 'text',
            bodyMarkdown:
              `### ${this.config.fill(t.gameStepTitle, {
                white: frag.white ?? '?',
                black: frag.black ?? '?',
                result: frag.result ?? '*',
              })}\n\n` +
              this.config.fill(t.gameSelfCheck, {
                themeLabel,
                opening: frag.opening ?? '—',
              }),
          },
        },
        userId,
      );
    }

    // 4. Закрепление: drill-шаг — случайные позиции по теме занятия
    //    (маппинг тема → drill-тип; нет соответствия → find-hanging-piece).
    await this.lessons.addStep(
      lesson.id,
      {
        type: 'drill',
        payload: {
          type: 'drill',
          drillType: this.drillTypeFor(theme),
          count: 5,
          minSolved: 3,
        },
      },
      userId,
    ).catch((e: Error) => {
      this.logger.warn(`drill step skipped: ${e.message}`);
    });

    return {
      lessonId: lesson.id,
      courseId: course.id,
      courseSlug: course.slug,
      themeLabel,
    };
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

  /** Тема пазлов → drill-тип закрепления (без соответствия → hanging piece). */
  private drillTypeFor(theme: string):
    | 'find-hanging-piece'
    | 'find-pin'
    | 'find-fork'
    | 'find-all-checks' {
    if (theme.toLowerCase().includes('pin')) return 'find-pin';
    if (theme.toLowerCase().includes('fork')) return 'find-fork';
    if (theme.toLowerCase().includes('mate')) return 'find-all-checks';
    return 'find-hanging-piece';
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
