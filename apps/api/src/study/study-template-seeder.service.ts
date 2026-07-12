import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { templateSlugFor, RATING_SHELVES } from './study-shelves';
import { STUDY_TEMPLATE_CONTENT } from './templates/study-template-content';

/**
 * KS-4911 / ADR-162 (решение architect). Ленивый сидер шаблонных
 * курсов занятий: скрытые СИСТЕМНЫЕ курсы `study-template-<shelf>`
 * (ownerId=null, isPublic=false, isPublished=false — в каталоги не
 * попадают) с одним шаблонным уроком на язык (en-урок ссылается на
 * ru через parentLessonId — существующий механизм переводов).
 *
 * Режим create-if-missing: существующий курс НЕ трогаем — после
 * первого сидинга источник истины БД, content правит шаблоны через
 * lessons/admin API, правки не перезатираются.
 */
@Injectable()
export class StudyTemplateSeederService {
  private readonly logger = new Logger(StudyTemplateSeederService.name);
  /** Кэш «полка уже обеспечена» на lifetime процесса. */
  private readonly ensured = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Гарантировать наличие шаблонного курса полки. Возвращает courseId. */
  async ensureTemplate(shelfKey: string): Promise<string | null> {
    const slug = templateSlugFor(shelfKey);
    const existing = await this.prisma.course.findFirst({
      where: { slug, ownerId: null },
      select: { id: true },
    });
    if (existing) {
      this.ensured.add(shelfKey);
      return existing.id;
    }

    const content = STUDY_TEMPLATE_CONTENT[shelfKey];
    if (!content) {
      this.logger.warn(`no template content for shelf ${shelfKey}`);
      return null;
    }

    const course = await this.prisma.course.create({
      data: {
        slug,
        ownerId: null,
        lang: 'ru',
        title: `Шаблон занятий: ${shelfKey}`,
        description: 'kingside:study-template-course',
        isPublic: false,
        isPublished: false,
      },
    });

    let ruLessonId: string | null = null;
    for (const lang of ['ru', 'en'] as const) {
      const lessonContent = content[lang];
      const lesson: { id: string } = await this.prisma.lesson.create({
        data: {
          courseId: course.id,
          ownerId: null,
          order: lang === 'ru' ? 0 : 1,
          slug: `template-${lang}`,
          title: lessonContent.title,
          estMinutes: 20,
          lang,
          ...(lang === 'en' && ruLessonId ? { parentLessonId: ruLessonId } : {}),
        },
      });
      if (lang === 'ru') ruLessonId = lesson.id;

      await this.prisma.lessonStep.createMany({
        data: lessonContent.steps.map((step, i) => ({
          lessonId: lesson.id,
          ownerId: null,
          order: i,
          type: step.type,
          payload: this.templatePayload(step),
        })),
      });
    }
    this.logger.log(`study template course seeded: ${slug}`);
    this.ensured.add(shelfKey);
    return course.id;
  }

  /** При старте — фоновое обеспечение всех полок (не блокирует bootstrap). */
  async ensureAll(): Promise<void> {
    for (const shelf of RATING_SHELVES) {
      try {
        await this.ensureTemplate(shelf.key);
      } catch (e) {
        this.logger.error(
          `ensureTemplate(${shelf.key}) failed: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Payload шаблонного шага (заглушки заменяет builder при клонировании). */
  private templatePayload(step: { type: string; bodyMarkdown?: string }) {
    switch (step.type) {
      case 'text':
        return { type: 'text', bodyMarkdown: step.bodyMarkdown ?? '' };
      case 'puzzle':
        // Значения-заглушки: builder подставляет тему и окно профиля.
        return {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['fork'], ratingMin: 1000, ratingMax: 1600, limit: 6 },
          minSolved: 4,
        };
      case 'game':
        // Плейсхолдер: builder заменяет партией пользователя либо
        // пропускает шаг, когда партий нет.
        return { type: 'game', sourceType: 'pgn', pgn: '{{userGamePgn}}' };
      case 'drill':
        return { type: 'drill', drillType: 'find-hanging-piece', count: 5, minSolved: 3 };
      default:
        return { type: 'text', bodyMarkdown: '' };
    }
  }
}
