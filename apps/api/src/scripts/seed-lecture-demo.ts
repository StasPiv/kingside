/**
 * KS-4321. Seed-фикстура для записи видеообзора D1 «Лекции» (KS-4316).
 *
 * Создаёт детерминированную базу для скрипта Playwright/контента:
 *   1. dev-пользователь `coach-demo` (тренер).
 *   2. сохранённый анализ под `coach-demo`. Реальный `analysisId`
 *      разблокирует пункт «Start lecture» в `AnalysisActionsMenu`
 *      (см. `apps/web/src/pages/AnalysisPage.tsx:918` — пункт disabled,
 *      если у страницы нет id; на фронт прокидывается
 *      `liveAnalysisId: analysisId ?? null` на строке 4369).
 *   3. scheduled-лекция под `coach-demo` со `scheduledAt = now + 10 min`,
 *      `visibility=public` — видна автору в секции «As a coach» и
 *      второму юзеру в «Discover public lectures».
 *   4. dev-пользователь `viewer-demo` (зритель) — для второго контекста
 *      Playwright.
 *
 * Запуск:
 *   npm run seed:lecture-demo --workspace=@kingside/api
 *
 * Идемпотентность:
 *   - User — upsert по `username`. При повторном запуске
 *     `passwordHash` перепрошивается (новая bcrypt-соль), пароль
 *     остаётся прежним.
 *   - Analysis — поиск по `(userId, sourceHash='seed:lecture-demo')`
 *     (partial UNIQUE `analyses_user_source_uniq`), update или create.
 *   - Lecture — findFirst по `(ownerId, title)`; на каждом запуске
 *     `scheduledAt` рефрешится до `now+10 min`, чтобы окно записи
 *     было всегда свежим. Если лекция перешла в `live/recorded`
 *     — возвращается обратно в `scheduled`, лайв-привязка обнуляется
 *     (фикстура должна давать стабильную сцену).
 *
 * Пароли:
 *   - `COACH_DEMO_PASSWORD` / `VIEWER_DEMO_PASSWORD` (env) — переопределение;
 *     по умолчанию `'demo'` (для локальной dev-записи видео).
 */

import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@kingside/db';

export const COACH_USERNAME = 'coach-demo';
export const VIEWER_USERNAME = 'viewer-demo';
export const COACH_EMAIL = 'coach-demo@kingside.local';
export const VIEWER_EMAIL = 'viewer-demo@kingside.local';
export const ANALYSIS_SOURCE_HASH = 'seed:lecture-demo';
export const ANALYSIS_TITLE = 'Демо-партия для лекции (KS-4321)';
export const ANALYSIS_PGN =
  '[Event "Seed demo"]\n' +
  '[White "coach-demo"]\n' +
  '[Black "viewer-demo"]\n\n' +
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *';
export const LECTURE_TITLE = 'Семинар: тактика в эндшпиле (демо)';
export const LECTURE_DESCRIPTION =
  'Демонстрационная лекция, сгенерированная seed-lecture-demo (KS-4321). ' +
  'Используется для записи обучающего видео по разделу «Лекции».';
export const DEFAULT_PASSWORD = 'demo';
export const SCHEDULED_AT_OFFSET_MS = 10 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

/**
 * Минимальный slice Prisma, который нужен seed-у. Сужен, чтобы spec
 * мог подсунуть фейк без полной типизации `PrismaClient`.
 */
type SeedPrisma = {
  user: {
    findUnique: (args: {
      where: { username: string };
      select: Record<string, boolean>;
    }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { username: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{ id: string; username: string }>;
  };
  analysis: {
    findFirst: (args: {
      where: { userId: string; sourceHash: string };
      select: Record<string, boolean>;
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{ id: string }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{ id: string }>;
  };
  lecture: {
    findFirst: (args: {
      where: { ownerId: string; title: string };
      select: Record<string, boolean>;
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{
      id: string;
      title: string;
      status: string;
      scheduledAt: Date | null;
    }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{
      id: string;
      title: string;
      status: string;
      scheduledAt: Date | null;
    }>;
  };
};

export interface SeedLectureDemoResult {
  coach: { id: string; username: string; created: boolean };
  viewer: { id: string; username: string; created: boolean };
  analysis: { id: string; created: boolean };
  lecture: {
    id: string;
    title: string;
    status: string;
    scheduledAt: Date | null;
    created: boolean;
  };
}

export interface SeedLectureDemoOptions {
  coachPassword: string;
  viewerPassword: string;
  /** Якорь для `scheduledAt` (по умолчанию `new Date()`). */
  now?: Date;
}

export async function runSeedLectureDemo(
  prisma: SeedPrisma,
  opts: SeedLectureDemoOptions,
): Promise<SeedLectureDemoResult> {
  if (!opts.coachPassword) {
    throw new Error('coachPassword must be a non-empty string');
  }
  if (!opts.viewerPassword) {
    throw new Error('viewerPassword must be a non-empty string');
  }
  const now = opts.now ?? new Date();
  const scheduledAt = new Date(now.getTime() + SCHEDULED_AT_OFFSET_MS);

  const coachHash = await bcrypt.hash(opts.coachPassword, BCRYPT_ROUNDS);
  const viewerHash = await bcrypt.hash(opts.viewerPassword, BCRYPT_ROUNDS);

  // 1. coach-demo
  const coachBefore = await prisma.user.findUnique({
    where: { username: COACH_USERNAME },
    select: { id: true },
  });
  const coach = await prisma.user.upsert({
    where: { username: COACH_USERNAME },
    update: {
      passwordHash: coachHash,
      requiresUsernameSetup: false,
    },
    create: {
      username: COACH_USERNAME,
      email: COACH_EMAIL,
      passwordHash: coachHash,
      requiresUsernameSetup: false,
    },
    select: { id: true, username: true },
  });

  // 2. viewer-demo
  const viewerBefore = await prisma.user.findUnique({
    where: { username: VIEWER_USERNAME },
    select: { id: true },
  });
  const viewer = await prisma.user.upsert({
    where: { username: VIEWER_USERNAME },
    update: {
      passwordHash: viewerHash,
      requiresUsernameSetup: false,
    },
    create: {
      username: VIEWER_USERNAME,
      email: VIEWER_EMAIL,
      passwordHash: viewerHash,
      requiresUsernameSetup: false,
    },
    select: { id: true, username: true },
  });

  // 3. Analysis под coach-demo. Используем sourceHash как «ключ
  // идемпотентности» — partial unique `(userId, sourceHash)` не даст
  // создать дубль при повторе. findFirst + update/create вместо
  // prisma.analysis.upsert, чтобы не зависеть от автогенеренного имени
  // составного ключа в Prisma-клиенте.
  const analysisBefore = await prisma.analysis.findFirst({
    where: { userId: coach.id, sourceHash: ANALYSIS_SOURCE_HASH },
    select: { id: true },
  });
  const analysis = analysisBefore
    ? await prisma.analysis.update({
        where: { id: analysisBefore.id },
        data: {
          title: ANALYSIS_TITLE,
          pgn: ANALYSIS_PGN,
          lastOpenedAt: now,
        },
        select: { id: true },
      })
    : await prisma.analysis.create({
        data: {
          userId: coach.id,
          title: ANALYSIS_TITLE,
          pgn: ANALYSIS_PGN,
          sourceHash: ANALYSIS_SOURCE_HASH,
          category: 'analysis',
          lastOpenedAt: now,
        },
        select: { id: true },
      });

  // 4. Lecture под coach-demo. Естественного UNIQUE-ключа у Lecture
  // нет (см. schema.prisma:2205) — идемпотентность по (ownerId, title).
  // При повторном запуске возвращаем лекцию в scheduled и обновляем
  // `scheduledAt`, чтобы окно записи было свежим.
  const lectureBefore = await prisma.lecture.findFirst({
    where: { ownerId: coach.id, title: LECTURE_TITLE },
    select: { id: true },
  });
  const lecture = lectureBefore
    ? await prisma.lecture.update({
        where: { id: lectureBefore.id },
        data: {
          description: LECTURE_DESCRIPTION,
          scheduledAt,
          status: 'scheduled',
          visibility: 'public',
          startedAt: null,
          endedAt: null,
          durationMs: null,
          liveAnalysisId: null,
        },
        select: {
          id: true,
          title: true,
          status: true,
          scheduledAt: true,
        },
      })
    : await prisma.lecture.create({
        data: {
          ownerId: coach.id,
          title: LECTURE_TITLE,
          description: LECTURE_DESCRIPTION,
          scheduledAt,
          status: 'scheduled',
          visibility: 'public',
        },
        select: {
          id: true,
          title: true,
          status: true,
          scheduledAt: true,
        },
      });

  return {
    coach: { id: coach.id, username: coach.username, created: !coachBefore },
    viewer: {
      id: viewer.id,
      username: viewer.username,
      created: !viewerBefore,
    },
    analysis: { id: analysis.id, created: !analysisBefore },
    lecture: {
      id: lecture.id,
      title: lecture.title,
      status: lecture.status,
      scheduledAt: lecture.scheduledAt,
      created: !lectureBefore,
    },
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const coachPassword = process.env.COACH_DEMO_PASSWORD ?? DEFAULT_PASSWORD;
    const viewerPassword =
      process.env.VIEWER_DEMO_PASSWORD ?? DEFAULT_PASSWORD;
    const r = await runSeedLectureDemo(
      prisma as unknown as SeedPrisma,
      { coachPassword, viewerPassword },
    );
    const flag = (s: { created: boolean }) =>
      s.created ? 'created' : 'updated';
    process.stdout.write(
      [
        '✓ seed-lecture-demo:',
        `  coach    ${flag(r.coach)} ${r.coach.username} (id=${r.coach.id})`,
        `  viewer   ${flag(r.viewer)} ${r.viewer.username} (id=${r.viewer.id})`,
        `  analysis ${flag(r.analysis)} id=${r.analysis.id}`,
        `  lecture  ${flag(r.lecture)} id=${r.lecture.id} ` +
          `status=${r.lecture.status} ` +
          `scheduledAt=${r.lecture.scheduledAt?.toISOString() ?? 'null'}`,
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`✗ seed-lecture-demo: ${msg}\n`);
    process.exit(1);
  });
}
