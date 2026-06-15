/**
 * KS-2095 — фильтрация курсов по языку и общий прогресс через root.
 *
 * Используем PrismaMock с двумя курсами одной семьи:
 *   root (lang=ru, parentCourseId=null)  ←  child (lang=en, parentCourseId=root.id)
 * и одним уроком на каждом курсе с одинаковым slug.
 */
import { NotFoundException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import type { PrismaService } from '../prisma/prisma.service';

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
  createdAt: Date;
  updatedAt: Date;
  _count?: { lessons: number };
  lessons?: Array<{
    id: string;
    slug: string;
    titleKey: string;
    order: number;
    parentLessonId: string | null;
  }>;
}

interface LessonRow {
  id: string;
  courseId: string;
  slug: string;
  lang: string;
  parentLessonId: string | null;
  order: number;
  blockKey: string;
  kind: string;
  titleKey: string;
  summaryKey: string;
  title: string | null;
  summary: string | null;
  estMinutes: number;
  isPublished: boolean;
  _count?: { steps: number };
}

function baseCourse(over: Partial<CourseRow>): CourseRow {
  return {
    id: '',
    slug: '',
    lang: 'ru',
    parentCourseId: null,
    level: 'beginner',
    titleKey: 'course.title',
    descriptionKey: 'course.desc',
    audienceI18nKey: null,
    hookI18nKey: null,
    outcomeI18nKey: null,
    title: null,
    description: null,
    audience: null,
    hook: null,
    outcome: null,
    coverUrl: null,
    difficulty: 2,
    estimatedMinutes: null,
    tags: [],
    blockOrder: [],
    order: 0,
    isPublished: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function baseLesson(over: Partial<LessonRow>): LessonRow {
  return {
    id: '',
    courseId: '',
    slug: '',
    lang: 'ru',
    parentLessonId: null,
    order: 0,
    blockKey: 'b1',
    kind: 'theory',
    titleKey: 'l.title',
    summaryKey: 'l.summary',
    title: null,
    summary: null,
    estMinutes: 10,
    isPublished: true,
    ...over,
  };
}

function makePrisma(state: {
  courses: CourseRow[];
  lessons: LessonRow[];
  userCourseProgress?: Array<{
    userId: string;
    courseId: string;
    startedAt: Date;
    completedAt: Date | null;
    currentLessonId: string | null;
    updatedAt: Date;
  }>;
  userLessonProgress?: Array<{
    userId: string;
    lessonId: string;
    completedAt: Date | null;
    startedAt: Date | null;
    masteredAt: Date | null;
    updatedAt: Date;
    stepsState: Record<string, string>;
  }>;
  /** KS-2101: locale пользователя из настроек профиля. Default 'ru'. */
  userLocale?: string;
}) {
  return {
    course: {
      findMany: jest.fn(async (args: { where: { isPublished: boolean; lang: string } }) => {
        return state.courses
          .filter(
            (c) =>
              c.isPublished === args.where.isPublished && c.lang === args.where.lang,
          )
          .map((c) => ({
            ...c,
            _count: {
              lessons: state.lessons.filter((l) => l.courseId === c.id && l.isPublished).length,
            },
            lessons: state.lessons
              .filter((l) => l.courseId === c.id && l.isPublished)
              .map((l) => ({
                id: l.id,
                slug: l.slug,
                titleKey: l.titleKey,
                order: l.order,
                parentLessonId: l.parentLessonId,
              })),
          }));
      }),
      findUnique: jest.fn(
        async (args: { where: { slug_lang: { slug: string; lang: string } } }) => {
          const { slug, lang } = args.where.slug_lang;
          const c = state.courses.find((x) => x.slug === slug && x.lang === lang);
          if (!c) return null;
          return {
            ...c,
            lessons: state.lessons
              .filter((l) => l.courseId === c.id && l.isPublished)
              .map((l) => ({ ...l, _count: { steps: 0 } })),
          };
        },
      ),
      // KS-2639 / ADR-054 §3.1 п.5. После Phase A `getCourseBySlug` ищет
      // системный курс через `findFirst({ slug, lang, ownerId: null })` —
      // мок повторяет ту же фильтрацию для обратной совместимости теста.
      findFirst: jest.fn(
        async (args: { where: { slug: string; lang: string; ownerId: string | null } }) => {
          const { slug, lang, ownerId } = args.where;
          const c = state.courses.find((x) => {
            const xOwner = (x as { ownerId?: string | null }).ownerId ?? null;
            return (
              x.slug === slug &&
              x.lang === lang &&
              // Фикстуры теста не содержат ownerId — сравниваем как
              // системные (ownerId IS NULL ⇔ undefined в фикстуре).
              xOwner === ownerId
            );
          });
          if (!c) return null;
          return {
            ...c,
            lessons: state.lessons
              .filter((l) => l.courseId === c.id && l.isPublished)
              .map((l) => ({ ...l, _count: { steps: 0 } })),
          };
        },
      ),
    },
    userCourseProgress: {
      findMany: jest.fn(async (args: { where: { userId: string; courseId: { in: string[] } } }) => {
        return (state.userCourseProgress ?? []).filter(
          (p) => p.userId === args.where.userId && args.where.courseId.in.includes(p.courseId),
        );
      }),
      findUnique: jest.fn(
        async (args: {
          where: { userId_courseId: { userId: string; courseId: string } };
        }) => {
          const { userId, courseId } = args.where.userId_courseId;
          return (state.userCourseProgress ?? []).find(
            (p) => p.userId === userId && p.courseId === courseId,
          );
        },
      ),
    },
    userLessonProgress: {
      findMany: jest.fn(
        async (args: { where: { userId: string; lessonId?: { in: string[] } } }) => {
          return (state.userLessonProgress ?? []).filter(
            (p) =>
              p.userId === args.where.userId &&
              (!args.where.lessonId || args.where.lessonId.in.includes(p.lessonId)),
          );
        },
      ),
    },
    lessonReview: {
      findMany: jest.fn(async () => []),
    },
    user: {
      findUnique: jest.fn(async (args: { select?: Record<string, boolean> }) => {
        // KS-2101: resolveUserLocale зовёт select:{locale:true};
        // recommendLevel зовёт select:{ratingPuzzle:true}.
        if (args?.select?.locale) {
          return { locale: state.userLocale ?? 'ru' };
        }
        return { ratingPuzzle: 1000 };
      }),
    },
  } as unknown as PrismaService;
}

describe('CoursesService — KS-2095 lang filter', () => {
  const ROOT_ID = 'course-root';
  const CHILD_ID = 'course-child';
  const ROOT_LESSON_ID = 'lesson-root';
  const CHILD_LESSON_ID = 'lesson-child';

  function setupTwoLangCourses() {
    const courses: CourseRow[] = [
      baseCourse({ id: ROOT_ID, slug: 'opening-basics', lang: 'ru' }),
      baseCourse({
        id: CHILD_ID,
        slug: 'opening-basics',
        lang: 'en',
        parentCourseId: ROOT_ID,
      }),
    ];
    const lessons: LessonRow[] = [
      baseLesson({ id: ROOT_LESSON_ID, courseId: ROOT_ID, slug: 'l1', lang: 'ru' }),
      baseLesson({
        id: CHILD_LESSON_ID,
        courseId: CHILD_ID,
        slug: 'l1',
        lang: 'en',
        parentLessonId: ROOT_LESSON_ID,
      }),
    ];
    return { courses, lessons };
  }

  // KS-2101: lang теперь берётся из User.locale в БД, а не из аргумента
  // listCourses/getCourseBySlug. В тестах подменяем `userLocale` через
  // фабрику mock-prisma. Anonymous (userId=null) → 'ru' fallback.

  it('listCourses() для anonymous → EN (default, KS-4145)', async () => {
    const prisma = makePrisma(setupTwoLangCourses());
    const svc = new CoursesService(prisma);
    // KS-4145: default сменился с 'ru' на 'en'; для анонимного запроса
    // без query-параметра возвращается EN-вариант.
    const res = await svc.listCourses(null);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(CHILD_ID);
  });

  it('listCourses(null, "ru") → query locale побеждает default EN', async () => {
    const prisma = makePrisma(setupTwoLangCourses());
    const svc = new CoursesService(prisma);
    const res = await svc.listCourses(null, 'ru');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(ROOT_ID);
  });

  it('listCourses("u1", "en") с User.locale=ru → query EN побеждает', async () => {
    const prisma = makePrisma({ ...setupTwoLangCourses(), userLocale: 'ru' });
    const svc = new CoursesService(prisma);
    const res = await svc.listCourses('u1', 'en');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(CHILD_ID);
  });

  it('listCourses() для пользователя с locale=en → только EN-курс', async () => {
    const prisma = makePrisma({ ...setupTwoLangCourses(), userLocale: 'en' });
    const svc = new CoursesService(prisma);
    const res = await svc.listCourses('u1');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(CHILD_ID);
  });

  it('listCourses() для пользователя с locale=ru → только RU-курс', async () => {
    const prisma = makePrisma({ ...setupTwoLangCourses(), userLocale: 'ru' });
    const svc = new CoursesService(prisma);
    const res = await svc.listCourses('u1');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(ROOT_ID);
  });

  it('listCourses() с locale="fr" в профиле → fallback на EN (default)', async () => {
    const prisma = makePrisma({ ...setupTwoLangCourses(), userLocale: 'fr' });
    const svc = new CoursesService(prisma);
    // KS-4145: невалидный User.locale ('fr') откатывается на default 'en'.
    const res = await svc.listCourses('u1');
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(CHILD_ID);
  });

  it('getCourseBySlug → 404 если на языке профиля курса нет', async () => {
    const prisma = makePrisma({
      courses: [baseCourse({ id: ROOT_ID, slug: 'opening-basics', lang: 'ru' })],
      lessons: [],
      userLocale: 'en',
    });
    const svc = new CoursesService(prisma);
    await expect(svc.getCourseBySlug('opening-basics', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('прогресс пользователя на RU читается на EN-варианте через root', async () => {
    const userId = 'u1';
    const startedAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-06-01');
    const prisma = makePrisma({
      ...setupTwoLangCourses(),
      userLocale: 'en',
      userCourseProgress: [
        {
          userId,
          courseId: ROOT_ID, // прогресс только по root
          startedAt,
          completedAt: null,
          currentLessonId: ROOT_LESSON_ID,
          updatedAt,
        },
      ],
      userLessonProgress: [
        {
          userId,
          lessonId: ROOT_LESSON_ID, // прогресс по root-уроку
          completedAt: null,
          startedAt,
          masteredAt: null,
          updatedAt,
          stepsState: { s1: 'done' },
        },
      ],
    });
    const svc = new CoursesService(prisma);

    // Пользователь с locale=en → выдача EN-курс, прогресс через root.
    const res = await svc.listCourses(userId);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(CHILD_ID);
    expect(res.data[0].progress).not.toBeNull();
    expect(res.data[0].progress?.startedAt).toBe(startedAt.toISOString());
  });
});
