/**
 * KS-2095 — импортёр курсов и уроков с lang/parent.
 *
 * Сценарии:
 *   - default lang='ru' → новый root-курс.
 *   - lang='en' без --parent → авто-резолв parent по slug.
 *   - lang='en' с --parent → явный parent.
 *   - EN-урок при upsert получает parentLessonId через root-курс по slug.
 */
import { LessonsAdminImportService } from './lessons-admin-import.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ImportRequestDto } from './dto/import-lesson.dto';

interface CourseRow {
  id: string;
  slug: string;
  lang: string;
  parentCourseId: string | null;
  level: string;
  titleKey: string;
  descriptionKey: string;
  audienceI18nKey: string | null;
  hookI18nKey: string | null;
  outcomeI18nKey: string | null;
  title: string | null;
  description: string | null;
  audience: string | null;
  hook: string | null;
  outcome: string | null;
  coverUrl: string | null;
  difficulty: number;
  estimatedMinutes: number | null;
  tags: string[];
  blockOrder: string[];
  order: number;
  isPublished: boolean;
}
interface LessonRow {
  id: string;
  courseId: string;
  slug: string;
  lang: string;
  parentLessonId: string | null;
  blockKey: string;
  kind: string;
  titleKey: string;
  summaryKey: string;
  title: string | null;
  summary: string | null;
  estMinutes: number;
  order: number;
  isPublished: boolean;
}

function makeMock() {
  const courses: CourseRow[] = [];
  const lessons: LessonRow[] = [];
  let nextC = 1;
  let nextL = 1;

  const tx = {
    course: {
      findUnique: jest.fn(
        async (args: { where: { slug_lang?: { slug: string; lang: string } } }) => {
          if (!args.where.slug_lang) return null;
          const { slug, lang } = args.where.slug_lang;
          return courses.find((c) => c.slug === slug && c.lang === lang) ?? null;
        },
      ),
      // KS-2639 / ADR-054 Phase A. lookup системного курса теперь идёт
      // через `findFirst({slug, lang, ownerId: null})` (partial-unique
      // namespace), а не compound-unique.
      findFirst: jest.fn(
        async (args: { where: { slug?: string; lang?: string; ownerId?: string | null } }) => {
          const { slug, lang, ownerId } = args.where;
          return (
            courses.find((c) => {
              if (slug !== undefined && c.slug !== slug) return false;
              if (lang !== undefined && c.lang !== lang) return false;
              if (ownerId !== undefined) {
                const cOwner = (c as { ownerId?: string | null }).ownerId ?? null;
                if (cOwner !== ownerId) return false;
              }
              return true;
            }) ?? null
          );
        },
      ),
      findMany: jest.fn(
        async (args: { where: { slug?: string; lang?: { not: string } } }) => {
          return courses.filter((c) => {
            if (args.where.slug && c.slug !== args.where.slug) return false;
            if (args.where.lang?.not && c.lang === args.where.lang.not) return false;
            return true;
          });
        },
      ),
      create: jest.fn(async (args: { data: Partial<CourseRow> }) => {
        const row: CourseRow = {
          id: `course-${nextC++}`,
          slug: args.data.slug!,
          lang: args.data.lang ?? 'ru',
          parentCourseId: args.data.parentCourseId ?? null,
          level: args.data.level ?? 'beginner',
          titleKey: args.data.titleKey ?? '',
          descriptionKey: args.data.descriptionKey ?? '',
          audienceI18nKey: args.data.audienceI18nKey ?? null,
          hookI18nKey: args.data.hookI18nKey ?? null,
          outcomeI18nKey: args.data.outcomeI18nKey ?? null,
          title: args.data.title ?? null,
          description: args.data.description ?? null,
          audience: args.data.audience ?? null,
          hook: args.data.hook ?? null,
          outcome: args.data.outcome ?? null,
          coverUrl: args.data.coverUrl ?? null,
          difficulty: args.data.difficulty ?? 2,
          estimatedMinutes: args.data.estimatedMinutes ?? null,
          tags: args.data.tags ?? [],
          blockOrder: args.data.blockOrder ?? [],
          order: args.data.order ?? 0,
          isPublished: Boolean(args.data.isPublished),
        };
        courses.push(row);
        return row;
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<CourseRow> }) => {
        const c = courses.find((x) => x.id === args.where.id)!;
        Object.assign(c, args.data);
        return c;
      }),
      aggregate: jest.fn(async () => ({
        _max: { order: courses.length === 0 ? null : Math.max(...courses.map((c) => c.order)) },
      })),
    },
    lesson: {
      findUnique: jest.fn(
        async (args: {
          where: { courseId_slug?: { courseId: string; slug: string } };
        }) => {
          if (!args.where.courseId_slug) return null;
          const { courseId, slug } = args.where.courseId_slug;
          return lessons.find((l) => l.courseId === courseId && l.slug === slug) ?? null;
        },
      ),
      create: jest.fn(async (args: { data: Partial<LessonRow> }) => {
        const row: LessonRow = {
          id: `lesson-${nextL++}`,
          courseId: args.data.courseId!,
          slug: args.data.slug!,
          lang: args.data.lang ?? 'ru',
          parentLessonId: args.data.parentLessonId ?? null,
          blockKey: args.data.blockKey ?? 'b',
          kind: args.data.kind ?? 'theory',
          titleKey: args.data.titleKey ?? '',
          summaryKey: args.data.summaryKey ?? '',
          title: args.data.title ?? null,
          summary: args.data.summary ?? null,
          estMinutes: args.data.estMinutes ?? 10,
          order: args.data.order ?? 0,
          isPublished: Boolean(args.data.isPublished),
        };
        lessons.push(row);
        return row;
      }),
    },
    lessonStep: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: `step-${Math.random()}`,
        ...args.data,
      })),
    },
    userLessonProgress: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma as never),
    ...tx,
  } as unknown as PrismaService;
  return { prisma, state: { courses, lessons } };
}

function makeDto(over: {
  course?: Partial<{
    slug: string;
    lang: 'ru' | 'en';
    parentSlug: string;
  }>;
  lesson?: Partial<{ courseSlug: string; slug: string }>;
}): ImportRequestDto {
  const dto: ImportRequestDto = {
    course: {
      schemaVersion: 1,
      slug: over.course?.slug ?? 'demo',
      lang: over.course?.lang,
      parentSlug: over.course?.parentSlug,
      level: 'beginner',
      titleKey: 'k.title',
      descriptionKey: 'k.desc',
    } as unknown as ImportRequestDto['course'],
    lesson: {
      schemaVersion: 1,
      courseSlug: over.lesson?.courseSlug ?? over.course?.slug ?? 'demo',
      slug: over.lesson?.slug ?? 'l1',
      order: 0,
      blockKey: 'b1',
      kind: 'theory',
      titleKey: 'l.title',
      summaryKey: 'l.summary',
      steps: [{ type: 'text', body: 'hi' }],
    } as unknown as ImportRequestDto['lesson'],
  };
  return dto;
}

describe('LessonsAdminImportService — KS-2095 lang/parent', () => {
  it('default lang=ru → создаёт root-курс', async () => {
    const { prisma, state } = makeMock();
    const svc = new LessonsAdminImportService(prisma);

    await svc.importLesson(makeDto({ course: { slug: 'demo' } }));

    expect(state.courses).toHaveLength(1);
    expect(state.courses[0].lang).toBe('ru');
    expect(state.courses[0].parentCourseId).toBeNull();
    expect(state.lessons[0].lang).toBe('ru');
    expect(state.lessons[0].parentLessonId).toBeNull();
  });

  it('lang=en без --parent: автоматически находит RU-root по slug', async () => {
    const { prisma, state } = makeMock();
    const svc = new LessonsAdminImportService(prisma);

    // Сначала RU-курс.
    await svc.importLesson(makeDto({ course: { slug: 'demo', lang: 'ru' } }));
    const ruCourse = state.courses[0];
    const ruLesson = state.lessons[0];

    // Теперь EN-вариант с тем же slug.
    await svc.importLesson(makeDto({ course: { slug: 'demo', lang: 'en' } }));

    expect(state.courses).toHaveLength(2);
    const en = state.courses.find((c) => c.lang === 'en')!;
    expect(en.parentCourseId).toBe(ruCourse.id);

    const enLesson = state.lessons.find((l) => l.lang === 'en')!;
    expect(enLesson.parentLessonId).toBe(ruLesson.id);
  });

  it('lang=en c явным --parent: использует указанный parentSlug', async () => {
    const { prisma, state } = makeMock();
    const svc = new LessonsAdminImportService(prisma);

    await svc.importLesson(makeDto({ course: { slug: 'beginner-basics' } }));
    const ruRoot = state.courses[0];

    // EN-вариант с другим slug, привязанный к ru через parentSlug.
    await svc.importLesson(
      makeDto({
        course: { slug: 'beginner-basics-en', lang: 'en', parentSlug: 'beginner-basics' },
        lesson: { courseSlug: 'beginner-basics-en' },
      }),
    );

    const en = state.courses.find((c) => c.lang === 'en')!;
    expect(en.parentCourseId).toBe(ruRoot.id);
  });

  it('lang=en parent не найден → ничего не привязывает (новый root)', async () => {
    const { prisma, state } = makeMock();
    const svc = new LessonsAdminImportService(prisma);

    // Никакого RU-курса нет — английский становится root.
    await svc.importLesson(makeDto({ course: { slug: 'demo', lang: 'en' } }));

    expect(state.courses).toHaveLength(1);
    expect(state.courses[0].parentCourseId).toBeNull();
  });

  it('lang=en с явным parentSlug которого нет → 404', async () => {
    const { prisma } = makeMock();
    const svc = new LessonsAdminImportService(prisma);

    await expect(
      svc.importLesson(
        makeDto({
          course: { slug: 'demo-en', lang: 'en', parentSlug: 'absent' },
          lesson: { courseSlug: 'demo-en' },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
