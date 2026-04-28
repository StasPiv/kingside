/**
 * KS-2018 / B-3 — unit-тесты `LessonsAdminImportService` с in-memory
 * mock'ом Prisma.
 *
 * Что покрываем:
 *  - вставка нового курса+урока+шагов; order проставляется по позиции;
 *  - идемпотентность: повторный вызов с тем же payload — diff пустой
 *    (всё unchanged), 0 UPDATE-ов;
 *  - удаление шага: 3 → 2 шага, в `removed` попал старый stepId,
 *    `UserLessonProgress.stepsState` чистится от удалённого id;
 *  - dryRun=true — фактических изменений нет (state как до вызова),
 *    diff в ответе посчитан;
 *  - ошибка при несовпадении course.slug ↔ lesson.courseSlug.
 *
 * Mock — упрощённая in-memory таблица. Транзакция представлена как
 * прямой вызов callback'а с тем же tx-объектом (rollback симулируется
 * через snapshot/restore до и после исключения).
 */
import { ConflictException } from '@nestjs/common';
import { LessonsAdminImportService } from './lessons-admin-import.service';
import type {
  ImportRequestDto,
  ImportLessonPayloadDto,
  ImportCoursePayloadDto,
} from './dto/import-lesson.dto';

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

interface StepRow {
  id: string;
  lessonId: string;
  order: number;
  type: string;
  payload: Record<string, unknown>;
}

interface ProgressRow {
  id: string;
  userId: string;
  lessonId: string;
  stepsState: Record<string, unknown>;
}

function makePrismaMock() {
  let nextCourseId = 1;
  let nextLessonId = 1;
  let nextStepId = 1;
  const courses: CourseRow[] = [];
  const lessons: LessonRow[] = [];
  const steps: StepRow[] = [];
  const progresses: ProgressRow[] = [];

  function snapshot() {
    return {
      courses: courses.map((x) => ({ ...x, tags: [...x.tags] })),
      lessons: lessons.map((x) => ({ ...x })),
      steps: steps.map((x) => ({ ...x, payload: { ...x.payload } })),
      progresses: progresses.map((x) => ({ ...x, stepsState: { ...x.stepsState } })),
    };
  }
  function restore(s: ReturnType<typeof snapshot>) {
    courses.length = 0;
    courses.push(...s.courses);
    lessons.length = 0;
    lessons.push(...s.lessons);
    steps.length = 0;
    steps.push(...s.steps);
    progresses.length = 0;
    progresses.push(...s.progresses);
  }

  const tx = {
    course: {
      findUnique: jest.fn(
        async (args: {
          where: {
            slug?: string;
            id?: string;
            slug_lang?: { slug: string; lang: string };
          };
        }) => {
          if (args.where.slug_lang) {
            const { slug, lang } = args.where.slug_lang;
            return (
              courses.find((c) => c.slug === slug && c.lang === lang) ?? null
            );
          }
          if (args.where.slug) return courses.find((c) => c.slug === args.where.slug) ?? null;
          if (args.where.id) return courses.find((c) => c.id === args.where.id) ?? null;
          return null;
        },
      ),
      // KS-2095: новые места в импортёре зовут findMany для поиска parent.
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
          id: `course-${nextCourseId++}`,
          slug: args.data.slug!,
          lang: (args.data.lang as string) ?? 'ru',
          parentCourseId: (args.data.parentCourseId as string | null) ?? null,
          level: (args.data.level as string) ?? 'beginner',
          titleKey: (args.data.titleKey as string) ?? '',
          descriptionKey: (args.data.descriptionKey as string) ?? '',
          audienceI18nKey: (args.data.audienceI18nKey as string | null) ?? null,
          hookI18nKey: (args.data.hookI18nKey as string | null) ?? null,
          outcomeI18nKey: (args.data.outcomeI18nKey as string | null) ?? null,
          title: (args.data.title as string | null) ?? null,
          description: (args.data.description as string | null) ?? null,
          audience: (args.data.audience as string | null) ?? null,
          hook: (args.data.hook as string | null) ?? null,
          outcome: (args.data.outcome as string | null) ?? null,
          coverUrl: (args.data.coverUrl as string | null) ?? null,
          difficulty: (args.data.difficulty as number) ?? 2,
          estimatedMinutes: (args.data.estimatedMinutes as number | null) ?? null,
          tags: (args.data.tags as string[]) ?? [],
          order: (args.data.order as number) ?? 0,
          isPublished: Boolean(args.data.isPublished),
        };
        courses.push(row);
        return row;
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<CourseRow> }) => {
        const c = courses.find((x) => x.id === args.where.id);
        if (!c) throw new Error('course not found');
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
          where: { id?: string; courseId_slug?: { courseId: string; slug: string } };
        }) => {
          if (args.where.id) return lessons.find((l) => l.id === args.where.id) ?? null;
          if (args.where.courseId_slug) {
            const { courseId, slug } = args.where.courseId_slug;
            return lessons.find((l) => l.courseId === courseId && l.slug === slug) ?? null;
          }
          return null;
        },
      ),
      create: jest.fn(async (args: { data: Partial<LessonRow> }) => {
        const row: LessonRow = {
          id: `lesson-${nextLessonId++}`,
          courseId: args.data.courseId!,
          slug: args.data.slug!,
          lang: args.data.lang ?? 'ru',
          parentLessonId: args.data.parentLessonId ?? null,
          blockKey: args.data.blockKey ?? '',
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
      update: jest.fn(async (args: { where: { id: string }; data: Partial<LessonRow> }) => {
        const l = lessons.find((x) => x.id === args.where.id);
        if (!l) throw new Error('lesson not found');
        Object.assign(l, args.data);
        return l;
      }),
    },
    lessonStep: {
      findMany: jest.fn(async (args: { where: { lessonId: string } }) => {
        return steps
          .filter((s) => s.lessonId === args.where.lessonId)
          .sort((a, b) => a.order - b.order);
      }),
      create: jest.fn(async (args: { data: Partial<StepRow> }) => {
        const row: StepRow = {
          id: `step-${nextStepId++}`,
          lessonId: args.data.lessonId!,
          order: args.data.order ?? 0,
          type: args.data.type ?? 'text',
          payload: (args.data.payload as Record<string, unknown>) ?? {},
        };
        steps.push(row);
        return row;
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<StepRow> }) => {
        const s = steps.find((x) => x.id === args.where.id);
        if (!s) throw new Error('step not found');
        Object.assign(s, args.data);
        return s;
      }),
      delete: jest.fn(async (args: { where: { id: string } }) => {
        const idx = steps.findIndex((x) => x.id === args.where.id);
        if (idx === -1) throw new Error('step not found');
        return steps.splice(idx, 1)[0]!;
      }),
    },
    userLessonProgress: {
      findMany: jest.fn(async (args: { where: { lessonId: string } }) => {
        return progresses
          .filter((p) => p.lessonId === args.where.lessonId)
          .map((p) => ({ id: p.id, stepsState: p.stepsState }));
      }),
      update: jest.fn(
        async (args: { where: { id: string }; data: { stepsState: Record<string, unknown> } }) => {
          const p = progresses.find((x) => x.id === args.where.id);
          if (!p) throw new Error('progress not found');
          p.stepsState = args.data.stepsState;
          return p;
        },
      ),
    },
  };

  const prisma = {
    ...tx,
    $transaction: jest.fn(async (cb: (innerTx: typeof tx) => Promise<unknown>) => {
      const before = snapshot();
      try {
        return await cb(tx);
      } catch (e) {
        // rollback симулируется по факту: восстанавливаем состояние до cb.
        restore(before);
        throw e;
      }
    }),
  };

  return { prisma, state: { courses, lessons, steps, progresses } };
}

const COURSE_PAYLOAD: ImportCoursePayloadDto = {
  schemaVersion: 1,
  slug: 'capablanca-primer',
  level: 'beginner',
  titleKey: 'lessons.cap.title',
  descriptionKey: 'lessons.cap.desc',
  title: 'Учебник Капабланки',
  description: 'Переводный учебник.',
  difficulty: 1,
};

function makeLessonPayload(steps: ImportLessonPayloadDto['steps']): ImportLessonPayloadDto {
  return {
    schemaVersion: 1,
    courseSlug: 'capablanca-primer',
    slug: 'ch1-rules',
    order: 1,
    blockKey: 'chapter-1',
    kind: 'theory',
    titleKey: 'lessons.ch1.title',
    summaryKey: 'lessons.ch1.summary',
    estMinutes: 30,
    isPublished: false,
    steps,
  };
}

describe('LessonsAdminImportService', () => {
  it('создаёт курс + урок + шаги с order=1..N', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    const dto: ImportRequestDto = {
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
        { type: 'text', bodyMarkdown: 'b' },
        { type: 'text', bodyMarkdown: 'c' },
      ] as ImportLessonPayloadDto['steps']),
    };
    const r = await svc.importLesson(dto);

    expect(r.ok).toBe(true);
    expect(r.course.created).toBe(true);
    expect(r.lesson.created).toBe(true);
    expect(r.diff.added).toHaveLength(3);
    expect(r.diff.added.map((d) => d.order)).toEqual([1, 2, 3]);
    expect(state.courses).toHaveLength(1);
    expect(state.lessons).toHaveLength(1);
    expect(state.steps).toHaveLength(3);
    expect(state.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('идемпотентность: повторный вызов не делает UPDATE-ов', async () => {
    const { prisma } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    const dto: ImportRequestDto = {
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
        { type: 'text', bodyMarkdown: 'b' },
      ] as ImportLessonPayloadDto['steps']),
    };
    await svc.importLesson(dto);
    // Сбросим счётчики `update` после первого прогона.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stepUpdate = (prisma as any).lessonStep.update as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const courseUpdate = (prisma as any).course.update as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lessonUpdate = (prisma as any).lesson.update as jest.Mock;
    stepUpdate.mockClear();
    courseUpdate.mockClear();
    lessonUpdate.mockClear();

    const r2 = await svc.importLesson(dto);
    expect(r2.diff.added).toHaveLength(0);
    expect(r2.diff.updated).toHaveLength(0);
    expect(r2.diff.removed).toHaveLength(0);
    expect(r2.diff.unchanged).toHaveLength(2);
    expect(r2.course.updated).toBe(false);
    expect(r2.lesson.updated).toBe(false);
    expect(stepUpdate).not.toHaveBeenCalled();
    expect(courseUpdate).not.toHaveBeenCalled();
    expect(lessonUpdate).not.toHaveBeenCalled();
  });

  it('удаление шага: 3 → 2; removed-id чистится из stepsState', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);

    // 1. Заливаем 3 шага.
    await svc.importLesson({
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
        { type: 'text', bodyMarkdown: 'b' },
        { type: 'text', bodyMarkdown: 'c' },
      ] as ImportLessonPayloadDto['steps']),
    });

    // 2. Имитируем прогресс пользователя по всем 3 шагам.
    const lessonId = state.lessons[0]!.id;
    const stepIds = state.steps.map((s) => s.id);
    state.progresses.push({
      id: 'prog-1',
      userId: 'user-1',
      lessonId,
      stepsState: {
        [stepIds[0]!]: 'done',
        [stepIds[1]!]: 'done',
        [stepIds[2]!]: 'in_progress',
      },
    });

    // 3. Импортируем тот же урок, но без 3-го шага.
    const r = await svc.importLesson({
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
        { type: 'text', bodyMarkdown: 'b' },
      ] as ImportLessonPayloadDto['steps']),
    });

    expect(r.diff.removed).toHaveLength(1);
    expect(r.diff.removed[0]!.stepId).toBe(stepIds[2]);
    expect(state.steps).toHaveLength(2);
    // ID первых двух не изменились (UPDATE без перезаписи payload не делается).
    expect(state.steps.map((s) => s.id)).toEqual([stepIds[0], stepIds[1]]);
    // stepsState потерял ключ удалённого шага.
    expect(state.progresses[0]!.stepsState).toEqual({
      [stepIds[0]!]: 'done',
      [stepIds[1]!]: 'done',
    });
  });

  it('UPDATE при изменении payload не меняет step.id (важно для прогресса)', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    await svc.importLesson({
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'old' },
      ] as ImportLessonPayloadDto['steps']),
    });
    const oldId = state.steps[0]!.id;
    const r = await svc.importLesson({
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'new body' },
      ] as ImportLessonPayloadDto['steps']),
    });
    expect(r.diff.updated).toHaveLength(1);
    expect(r.diff.updated[0]!.stepId).toBe(oldId);
    expect(state.steps[0]!.id).toBe(oldId);
    expect(state.steps[0]!.payload).toMatchObject({
      type: 'text',
      bodyMarkdown: 'new body',
    });
  });

  it('dryRun=true: в БД ничего не меняется, diff посчитан', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    const r = await svc.importLesson({
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'hello' },
      ] as ImportLessonPayloadDto['steps']),
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.diff.added).toHaveLength(1);
    expect(state.courses).toHaveLength(0);
    expect(state.lessons).toHaveLength(0);
    expect(state.steps).toHaveLength(0);
  });

  it('бросает ConflictException при course.slug != lesson.courseSlug', async () => {
    const { prisma } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    const dto: ImportRequestDto = {
      course: { ...COURSE_PAYLOAD, slug: 'other-course' },
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
      ] as ImportLessonPayloadDto['steps']),
    };
    await expect(svc.importLesson(dto)).rejects.toThrow(ConflictException);
  });

  it('бросает 404 если курс не существует и payload курса не передан', async () => {
    const { prisma } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    const dto: ImportRequestDto = {
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
      ] as ImportLessonPayloadDto['steps']),
    };
    await expect(svc.importLesson(dto)).rejects.toThrow(/Course "capablanca-primer"/);
  });

  it('откат при ошибке внутри транзакции (DELETE падает) — БД не изменилась', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    // 1. Создаём курс + урок + 2 шага.
    await svc.importLesson({
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'a' },
        { type: 'text', bodyMarkdown: 'b' },
      ] as ImportLessonPayloadDto['steps']),
    });
    const beforeSteps = state.steps.map((s) => s.id);

    // 2. Подменяем `lessonStep.delete` на throw — имитируем DB-ошибку.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).lessonStep.delete = jest.fn(async () => {
      throw new Error('simulated DB failure');
    });

    // 3. Пробуем удалить шаг (1 шаг вместо 2) — должно упасть и откатить.
    await expect(
      svc.importLesson({
        lesson: makeLessonPayload([
          { type: 'text', bodyMarkdown: 'a' },
        ] as ImportLessonPayloadDto['steps']),
      }),
    ).rejects.toThrow(/simulated DB failure/);

    // 4. БД осталась прежней (2 шага, те же id).
    expect(state.steps).toHaveLength(2);
    expect(state.steps.map((s) => s.id)).toEqual(beforeSteps);
  });

  it('order шагов перезаписывается на 1..N даже если в файле другой порядок', async () => {
    const { prisma, state } = makePrismaMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new LessonsAdminImportService(prisma as any);
    await svc.importLesson({
      course: COURSE_PAYLOAD,
      lesson: makeLessonPayload([
        { type: 'text', bodyMarkdown: 'first' },
        { type: 'text', bodyMarkdown: 'second' },
        { type: 'text', bodyMarkdown: 'third' },
      ] as ImportLessonPayloadDto['steps']),
    });
    expect(state.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });
});
