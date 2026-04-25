/**
 * Идемпотентный сидер пользовательских курсов (`UserCourse`) для
 * dev-БД (KS-1887).
 *
 * Контекст: фронтенд-агент не мог снять live UI-скрины
 * `/lessons/my/:slug` и `/lessons/my/:slug/:lessonId` — на чистой
 * dev-БД таких курсов просто нет, `GET /api/lessons/user-courses/:slug`
 * → 404. QA в KS-1876 создавал курсы на лету через REST, но для
 * стабильных скринов (и e2e-проверок KS-1880/1882/1886) нужно
 * предсказуемое состояние, которое лежит в БД при старте dev-стенда.
 *
 * Запуск:
 *   `npm run seed:user-courses --workspace=@kingside/api`
 *
 * Что создаёт (от имени `DEV` юзера, см. `packages/db/prisma/seed.ts`):
 *   1. `demo-public-course` — public, 2 урока:
 *        - Урок 1: 2 text-шага
 *        - Урок 2: 1 text + 1 puzzle (filter-mode, mateIn1) + 1
 *          endgame_drill (winCondition.kind = 'mate')
 *   2. `demo-private-course` — private, 1 урок (1 text-шаг) —
 *      нужен для UI-проверок «owner-only views».
 *
 * Идемпотентность:
 *   - upsert курса по уникальному `slug` (DEV — фиксированный owner);
 *   - уроки + шаги переписываются полностью на каждый запуск
 *     (`deleteMany` + `create`), как и в системном `seed-lessons.ts`.
 *     Это удобнее, чем поштучный upsert: shape шага меняется
 *     (особенно `endgame_drill.winCondition`), а стабильного
 *     `step.id` у нас нет — UserLessonStep.id генерирует Prisma.
 *
 * Side-effect: каскад `UserLesson.delete → UserLessonPlayProgress`
 * сотрёт чужие прогрессы по этим урокам. Для dev-БД это ОК — там
 * нет данных продакшена. На prod этот скрипт не запускать.
 */

import 'dotenv/config';
import { PrismaClient } from '@kingside/db';
import { DEV_USER_ID } from '@kingside/shared';
import type { StepPayload } from '@kingside/shared';

interface SeedStep {
  order: number;
  type: 'text' | 'puzzle' | 'endgame_drill';
  payload: StepPayload;
}

interface SeedLesson {
  order: number;
  title: string;
  estMinutes: number | null;
  steps: SeedStep[];
}

interface SeedCourse {
  slug: string;
  title: string;
  description: string;
  isPublic: boolean;
  lessons: SeedLesson[];
}

// KP-эндшпиль: белая пешка e2 + король e1, чёрный король e8. Валидный
// FEN для `endgame_drill` (chess.js принимает; см. `lessons/dto/
// endgame-drill-step.dto.spec.ts`, тот же стартовый FEN).
const KP_KK_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';

const COURSES: SeedCourse[] = [
  {
    slug: 'demo-public-course',
    title: 'Demo public course',
    description:
      'Demo course with mixed step types — for live UI screenshots ' +
      '(KS-1876/1878/1884/1886) and manual e2e of /lessons/my flows.',
    isPublic: true,
    lessons: [
      {
        order: 0,
        title: 'Lesson 1 — text only',
        estMinutes: 5,
        steps: [
          {
            order: 0,
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown:
                '# Step 1.1\n\nFirst text step. ' +
                'Renders as Markdown in `TextStep`.',
            },
          },
          {
            order: 1,
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown:
                '## Step 1.2 — with diagram\n\nSecond text step ' +
                'with a starting-position diagram.',
              diagrams: [
                {
                  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                },
              ],
            },
          },
        ],
      },
      {
        order: 1,
        title: 'Lesson 2 — text + puzzle + endgame drill',
        estMinutes: 10,
        steps: [
          {
            order: 0,
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown:
                '# Step 2.1\n\nIntro text before the practice steps.',
            },
          },
          {
            order: 1,
            type: 'puzzle',
            payload: {
              type: 'puzzle',
              selection: {
                mode: 'filter',
                themes: ['mateIn1'],
                limit: 2,
              },
            },
          },
          {
            order: 2,
            type: 'endgame_drill',
            payload: {
              type: 'endgame_drill',
              fen: KP_KK_FEN,
              playerSide: 'white',
              skillLevel: 0,
              winCondition: { kind: 'mate' },
            },
          },
        ],
      },
    ],
  },
  {
    slug: 'demo-private-course',
    title: 'Demo private course',
    description:
      'Private demo course — used to verify owner-only views ' +
      '(KS-1885 stats card, edit screens for non-public state).',
    isPublic: false,
    lessons: [
      {
        order: 0,
        title: 'Lesson 1 — single text step',
        estMinutes: 3,
        steps: [
          {
            order: 0,
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown:
                '# Private course step\n\nThis course is `isPublic=false` ' +
                '— only the author should see it in `/lessons/my`.',
            },
          },
        ],
      },
    ],
  },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // Sanity-check: DEV-юзер должен существовать (создаётся в
    // packages/db/prisma/seed.ts). Иначе FK на user_courses.owner_id
    // ляжет с понятной ошибкой.
    const dev = await prisma.user.findUnique({ where: { id: DEV_USER_ID } });
    if (!dev) {
      process.stderr.write(
        '✗ seed-user-courses: DEV user not found in DB. ' +
          'Run `npm run prisma:seed --workspace=@kingside/db` first ' +
          '(creates DEV user used as the demo author).\n',
      );
      process.exit(1);
    }

    let upsertedCourses = 0;
    let writtenLessons = 0;
    let writtenSteps = 0;

    for (const course of COURSES) {
      const dbCourse = await prisma.userCourse.upsert({
        where: { slug: course.slug },
        update: {
          title: course.title,
          description: course.description,
          isPublic: course.isPublic,
        },
        create: {
          ownerId: DEV_USER_ID,
          slug: course.slug,
          title: course.title,
          description: course.description,
          isPublic: course.isPublic,
        },
      });
      upsertedCourses++;

      // Полная перезапись уроков и шагов: cascade на user_lessons
      // снесёт user_lesson_steps (FK ON DELETE CASCADE) и связанные
      // user_lesson_play_progress. Это допустимо в dev: фикстура —
      // источник истины.
      await prisma.userLesson.deleteMany({
        where: { userCourseId: dbCourse.id },
      });

      for (const lesson of course.lessons) {
        const dbLesson = await prisma.userLesson.create({
          data: {
            userCourseId: dbCourse.id,
            order: lesson.order,
            title: lesson.title,
            estMinutes: lesson.estMinutes,
          },
        });
        writtenLessons++;

        if (lesson.steps.length > 0) {
          await prisma.userLessonStep.createMany({
            data: lesson.steps.map((s) => ({
              userLessonId: dbLesson.id,
              order: s.order,
              type: s.type,
              // class-validator-проверка `payload` отсутствует на
              // уровне сервиса при createMany — но фикстура типизирована
              // через `StepPayload`, а валидаторы DTO уже покрыты юнит-
              // тестами (`step-payload.dto.spec.ts`,
              // `endgame-drill-step.dto.spec.ts`).
              payload: s.payload as unknown as object,
            })),
          });
          writtenSteps += lesson.steps.length;
        }
      }
    }

    // Сбрасываем мёртвый прогресс по этим курсам у не-DEV юзеров.
    // Идемпотентно: после deleteMany уроков выше каскад уже сработал,
    // но если когда-то в БД оставались осиротевшие записи прогресса —
    // здесь их добьёт.
    const courseIds = (
      await prisma.userCourse.findMany({
        where: { slug: { in: COURSES.map((c) => c.slug) } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (courseIds.length > 0) {
      await prisma.userCoursePlayProgress.deleteMany({
        where: { userCourseId: { in: courseIds } },
      });
    }

    process.stdout.write(
      `✓ seed-user-courses done: ${upsertedCourses} course(s), ` +
        `${writtenLessons} lesson(s), ${writtenSteps} step(s) ` +
        `(owner: DEV ${DEV_USER_ID})\n`,
    );
    for (const c of COURSES) {
      process.stdout.write(
        `  - /lessons/my/${c.slug} (${c.isPublic ? 'public' : 'private'}, ` +
          `${c.lessons.length} lesson(s))\n`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ seed-user-courses crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
