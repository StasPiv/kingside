/**
 * KS-4321: контракт `runSeedLectureDemo`.
 *
 * Покрытие чистой функции без CLI-обёртки и реального PrismaClient:
 *   - пустые пароли → throws, БД не дёргается;
 *   - первый запуск (всё отсутствует) → create-ветки для всех 4 сущностей,
 *     `created=true` в результате;
 *   - повторный запуск (всё уже есть) → update-ветки, `created=false`;
 *   - `scheduledAt` лекции считается от `opts.now` (= now + 10 минут);
 *   - Lecture идёт со `status='scheduled'` и `visibility='public'`
 *     — иначе она не попадёт в «Discover» у viewer-demo и в «As a coach»
 *     у coach-demo (см. lectures-public/my контроллеры).
 *
 * `bcrypt.hash` мокаем — иначе тест долгий и завязывается на случайную
 * соль.
 */

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

import {
  runSeedLectureDemo,
  ANALYSIS_SOURCE_HASH,
  ANALYSIS_TITLE,
  COACH_USERNAME,
  COACH_EMAIL,
  LECTURE_TITLE,
  SCHEDULED_AT_OFFSET_MS,
  VIEWER_USERNAME,
  VIEWER_EMAIL,
} from './seed-lecture-demo';

interface MakePrismaInit {
  coachExists: boolean;
  viewerExists: boolean;
  analysisExists: boolean;
  lectureExists: boolean;
}

type UpsertArg = {
  where: { username: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};
type CreateArg = { data: Record<string, unknown> };
type UpdateArg = { where: { id: string }; data: Record<string, unknown> };

function makePrisma(init: MakePrismaInit) {
  const userFindUnique = jest.fn(
    async ({ where }: { where: { username: string } }) => {
      if (where.username === COACH_USERNAME) {
        return init.coachExists ? { id: 'uuid-coach' } : null;
      }
      if (where.username === VIEWER_USERNAME) {
        return init.viewerExists ? { id: 'uuid-viewer' } : null;
      }
      return null;
    },
  );
  const userUpsert = jest.fn(async (arg: UpsertArg) => {
    if (arg.where.username === COACH_USERNAME) {
      return { id: 'uuid-coach', username: COACH_USERNAME };
    }
    return { id: 'uuid-viewer', username: VIEWER_USERNAME };
  });

  const analysisFindFirst = jest.fn(async () =>
    init.analysisExists ? { id: 'uuid-analysis' } : null,
  );
  const analysisCreate = jest.fn(async (_arg: CreateArg) => ({
    id: 'uuid-analysis',
  }));
  const analysisUpdate = jest.fn(async (_arg: UpdateArg) => ({
    id: 'uuid-analysis',
  }));

  const lectureFindFirst = jest.fn(async () =>
    init.lectureExists ? { id: 'uuid-lecture' } : null,
  );
  const lectureCreate = jest.fn(async (arg: CreateArg) => ({
    id: 'uuid-lecture',
    title: arg.data.title as string,
    status: arg.data.status as string,
    scheduledAt: (arg.data.scheduledAt as Date | null | undefined) ?? null,
  }));
  const lectureUpdate = jest.fn(async (arg: UpdateArg) => ({
    id: 'uuid-lecture',
    title: LECTURE_TITLE,
    status: arg.data.status as string,
    scheduledAt: (arg.data.scheduledAt as Date | null | undefined) ?? null,
  }));

  return {
    prisma: {
      user: { findUnique: userFindUnique, upsert: userUpsert },
      analysis: {
        findFirst: analysisFindFirst,
        create: analysisCreate,
        update: analysisUpdate,
      },
      lecture: {
        findFirst: lectureFindFirst,
        create: lectureCreate,
        update: lectureUpdate,
      },
    },
    userFindUnique,
    userUpsert,
    analysisFindFirst,
    analysisCreate,
    analysisUpdate,
    lectureFindFirst,
    lectureCreate,
    lectureUpdate,
  };
}

const NOW = new Date('2026-06-17T12:00:00.000Z');
const EXPECTED_SCHEDULED_AT = new Date(NOW.getTime() + SCHEDULED_AT_OFFSET_MS);

describe('runSeedLectureDemo (KS-4321)', () => {
  it('пустой coachPassword → throws, БД не трогаем', async () => {
    const { prisma, userUpsert } = makePrisma({
      coachExists: false,
      viewerExists: false,
      analysisExists: false,
      lectureExists: false,
    });
    await expect(
      runSeedLectureDemo(prisma, { coachPassword: '', viewerPassword: 'demo' }),
    ).rejects.toThrow(/coachPassword/);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it('пустой viewerPassword → throws, БД не трогаем', async () => {
    const { prisma, userUpsert } = makePrisma({
      coachExists: false,
      viewerExists: false,
      analysisExists: false,
      lectureExists: false,
    });
    await expect(
      runSeedLectureDemo(prisma, { coachPassword: 'demo', viewerPassword: '' }),
    ).rejects.toThrow(/viewerPassword/);
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it('первый запуск → все четыре сущности созданы (created=true)', async () => {
    const ctx = makePrisma({
      coachExists: false,
      viewerExists: false,
      analysisExists: false,
      lectureExists: false,
    });

    const r = await runSeedLectureDemo(ctx.prisma, {
      coachPassword: 'p-coach',
      viewerPassword: 'p-viewer',
      now: NOW,
    });

    expect(r.coach).toEqual({
      id: 'uuid-coach',
      username: COACH_USERNAME,
      created: true,
    });
    expect(r.viewer).toEqual({
      id: 'uuid-viewer',
      username: VIEWER_USERNAME,
      created: true,
    });
    expect(r.analysis).toEqual({ id: 'uuid-analysis', created: true });
    expect(r.lecture.created).toBe(true);
    expect(r.lecture.status).toBe('scheduled');
    expect(r.lecture.scheduledAt?.toISOString()).toBe(
      EXPECTED_SCHEDULED_AT.toISOString(),
    );

    // coach-upsert: оба create и update прошивают passwordHash, в create
    // подставляется e-mail и сбрасывается requiresUsernameSetup.
    const coachCall = ctx.userUpsert.mock.calls
      .map((c) => c[0])
      .find((arg) => arg.where.username === COACH_USERNAME);
    if (!coachCall) throw new Error('coach upsert call missing');
    expect(coachCall.create).toMatchObject({
      username: COACH_USERNAME,
      email: COACH_EMAIL,
      passwordHash: 'hashed:p-coach',
      requiresUsernameSetup: false,
    });
    expect(coachCall.update).toMatchObject({
      passwordHash: 'hashed:p-coach',
      requiresUsernameSetup: false,
    });

    const viewerCall = ctx.userUpsert.mock.calls
      .map((c) => c[0])
      .find((arg) => arg.where.username === VIEWER_USERNAME);
    if (!viewerCall) throw new Error('viewer upsert call missing');
    expect(viewerCall.create).toMatchObject({
      username: VIEWER_USERNAME,
      email: VIEWER_EMAIL,
      passwordHash: 'hashed:p-viewer',
    });

    expect(ctx.analysisCreate).toHaveBeenCalledTimes(1);
    const analysisCreateData = ctx.analysisCreate.mock.calls[0][0].data;
    expect(analysisCreateData).toMatchObject({
      userId: 'uuid-coach',
      sourceHash: ANALYSIS_SOURCE_HASH,
      title: ANALYSIS_TITLE,
      category: 'analysis',
    });
    expect(ctx.analysisUpdate).not.toHaveBeenCalled();

    expect(ctx.lectureCreate).toHaveBeenCalledTimes(1);
    const lectureCreateData = ctx.lectureCreate.mock.calls[0][0].data;
    expect(lectureCreateData).toMatchObject({
      ownerId: 'uuid-coach',
      title: LECTURE_TITLE,
      status: 'scheduled',
      visibility: 'public',
    });
    expect((lectureCreateData.scheduledAt as Date).toISOString()).toBe(
      EXPECTED_SCHEDULED_AT.toISOString(),
    );
    expect(ctx.lectureUpdate).not.toHaveBeenCalled();
  });

  it('повторный запуск → все четыре уже есть, идём в update-ветку (created=false)', async () => {
    const ctx = makePrisma({
      coachExists: true,
      viewerExists: true,
      analysisExists: true,
      lectureExists: true,
    });

    const r = await runSeedLectureDemo(ctx.prisma, {
      coachPassword: 'demo',
      viewerPassword: 'demo',
      now: NOW,
    });

    expect(r.coach.created).toBe(false);
    expect(r.viewer.created).toBe(false);
    expect(r.analysis.created).toBe(false);
    expect(r.lecture.created).toBe(false);

    expect(ctx.analysisCreate).not.toHaveBeenCalled();
    expect(ctx.analysisUpdate).toHaveBeenCalledTimes(1);

    expect(ctx.lectureCreate).not.toHaveBeenCalled();
    expect(ctx.lectureUpdate).toHaveBeenCalledTimes(1);
    // На повторе лекцию возвращаем в scheduled и обновляем scheduledAt.
    const updateCall = ctx.lectureUpdate.mock.calls[0][0];
    const lectureUpdateData = updateCall.data;
    expect(lectureUpdateData).toMatchObject({
      status: 'scheduled',
      visibility: 'public',
      startedAt: null,
      endedAt: null,
      liveAnalysisId: null,
    });
    expect((lectureUpdateData.scheduledAt as Date).toISOString()).toBe(
      EXPECTED_SCHEDULED_AT.toISOString(),
    );
  });

  it('DB-ошибка из lecture.create пробрасывается наружу', async () => {
    const ctx = makePrisma({
      coachExists: false,
      viewerExists: false,
      analysisExists: false,
      lectureExists: false,
    });
    ctx.lectureCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      runSeedLectureDemo(ctx.prisma, {
        coachPassword: 'demo',
        viewerPassword: 'demo',
        now: NOW,
      }),
    ).rejects.toThrow(/db down/);
  });
});
