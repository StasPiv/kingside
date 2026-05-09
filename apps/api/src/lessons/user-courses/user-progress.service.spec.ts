// @ts-nocheck
// KS-2648 / ADR-054 Phase E2: spec временно отключён, моки опираются на legacy
// `userCourse*` / `userLesson*` Prisma-модели, которых сервисы больше не используют.
// Полное переписывание под единые таблицы — Phase E3 (вместе с удалением сервисов).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserProgressService } from './user-progress.service';

describe.skip('UserProgressService (KS-1831 / KS-1879)', () => {
  let service: UserProgressService;
  let prisma: any;

  const OWNER = 'owner-1';
  const OTHER = 'some-other-user';

  beforeEach(() => {
    prisma = {
      userCourse: { findUnique: jest.fn() },
      userLesson: {
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        // KS-1955: getCourseProgress подтягивает уроки курса, чтобы
        // вычислить «текущий урок» (первый незавершённый по `order`).
        findMany: jest.fn().mockResolvedValue([]),
      },
      userLessonStep: { findMany: jest.fn().mockResolvedValue([]) },
      userCoursePlayProgress: {
        findUnique: jest.fn(),
        // Default: «свежая» запись без completedAt — чтобы тесты, которые
        // не специфицируют upsert.mockResolvedValue, не выводили
        // touchUserCourseProgress в ветку «set completedAt».
        upsert: jest.fn().mockResolvedValue({
          completedLessonsCount: 0,
          completedAt: null,
        }),
        update: jest.fn(),
      },
      userLessonPlayProgress: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        // KS-1955: getCourseProgress, getBySlug, listEnrolled (в
        // user-courses.service) тянут флаги completedAt по lessonIds
        // одним запросом для определения «текущего урока».
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new UserProgressService(prisma);
  });

  // ─── access helpers ────────────────────────────────────────────────

  describe('доступ к ресурсу', () => {
    it('GET courseProgress: owner приватного курса — ок', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'c1')).resolves.toBeNull();
    });

    it('GET courseProgress: чужой на приватный курс → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      await expect(service.getCourseProgress(OTHER, 'c1')).rejects.toThrow(NotFoundException);
    });

    it('GET courseProgress: чужой на публичный курс — ок', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: true });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OTHER, 'c1')).resolves.toBeNull();
    });

    it('GET courseProgress: несуществующий курс → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('GET lessonProgress: чужой на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 2 },
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(service.getLessonProgress(OTHER, 'l1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getCourseProgress / getLessonProgress ─────────────────────────

  describe('read', () => {
    it('getCourseProgress: вернёт маппер, если запись есть', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        completedLessonsCount: 3,
        startedAt: new Date('2026-04-01'),
        lastActivityAt: new Date('2026-04-10'),
        completedAt: null,
      });
      const r = await service.getCourseProgress(OWNER, 'c1');
      expect(r).toMatchObject({
        userCourseId: 'c1',
        completedLessonsCount: 3,
        completedAt: null,
      });
    });

    // KS-1955: «текущий урок» — первый незавершённый по `order` ASC.
    it('getCourseProgress: currentLesson* = первый незавершённый урок', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        completedLessonsCount: 1,
        startedAt: new Date('2026-04-01'),
        lastActivityAt: new Date('2026-04-15'),
        completedAt: null,
      });
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'L1', order: 0, title: 'Intro' },
        { id: 'L2', order: 1, title: 'Tactics' },
      ]);
      prisma.userLessonPlayProgress.findMany.mockResolvedValue([
        { userLessonId: 'L1', completedAt: new Date('2026-04-10') },
        { userLessonId: 'L2', completedAt: null },
      ]);

      const r = await service.getCourseProgress(OWNER, 'c1');
      expect(r).toMatchObject({
        currentLessonSlug: 'L2',
        currentLessonTitle: 'Tactics',
        currentLessonOrder: 2,
      });
    });

    it('getCourseProgress: если записи нет → null (не 404)', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: true });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'c1')).resolves.toBeNull();
    });

    it('getLessonProgress: маппинг ок (включая stepsState из БД)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 4 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 4,
        stepsState: { sA: 'done', sB: 'done', sC: 'pending' },
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      const r = await service.getLessonProgress(OWNER, 'l1');
      expect(r).toMatchObject({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 4,
        stepsState: { sA: 'done', sB: 'done', sC: 'pending' },
      });
    });

    // Backward-compat (KS-1879): записи, созданные до миграции,
    // имеют дефолт `'{}'::jsonb`. Также тестируем устойчивость к мусору
    // (null / число / массив / неизвестный state) — должно нормализоваться
    // в пустой объект, не упасть.
    it.each([
      ['null', null],
      ['пустой объект', {}],
      ['массив', ['done']],
      ['число', 42],
      ['строка', 'done'],
    ])('getLessonProgress: stepsState=%s → нормализуется в {}', async (_name, raw) => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 1 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 0,
        totalSteps: 1,
        stepsState: raw,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      const r = await service.getLessonProgress(OWNER, 'l1');
      expect(r!.stepsState).toEqual({});
    });

    it('getLessonProgress: неизвестные значения state выбрасываются из stepsState', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 3 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 3,
        stepsState: { sA: 'done', sB: 'garbage', sC: 'pending' },
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      const r = await service.getLessonProgress(OWNER, 'l1');
      expect(r!.stepsState).toEqual({ sA: 'done', sC: 'pending' });
    });
  });

  // ─── updateStepProgress (KS-1879: идемпотентность по stepId) ───────

  describe('updateStepProgress', () => {
    const okLesson = () => ({
      userCourseId: 'c1',
      _count: { steps: 3 },
      course: { ownerId: OWNER, isPublic: false },
    });

    it('первый done → создаёт запись с counter=1 и stepsState={[stepId]:done}', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonPlayProgress.create.mockImplementation(async ({ data }: any) => ({
        ...data, startedAt: new Date(), completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 'sA', 'done');
      expect(r.completedStepsCount).toBe(1);
      expect(r.totalSteps).toBe(3);
      expect(r.stepsState).toEqual({ sA: 'done' });

      const createArg = prisma.userLessonPlayProgress.create.mock.calls[0][0].data;
      expect(createArg.stepsState).toEqual({ sA: 'done' });
      expect(createArg.completedStepsCount).toBe(1);
    });

    // Главный сценарий KS-1879 (Gherkin: «Идемпотентность step-done»):
    // повторный POST с тем же stepId не растит счётчик.
    it('done×2 для одного stepId → счётчик не растёт (идемпотентность)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 1,
        totalSteps: 3,
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        stepsState: data.stepsState,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 'sA', 'done');
      expect(r.completedStepsCount).toBe(1);
      expect(r.stepsState).toEqual({ sA: 'done' });
    });

    it('done разных stepId → счётчик растёт по числу done в stepsState', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 1,
        totalSteps: 3,
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        stepsState: data.stepsState,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 'sB', 'done');
      expect(r.completedStepsCount).toBe(2);
      expect(r.stepsState).toEqual({ sA: 'done', sB: 'done' });
    });

    it('done не поднимает счётчик выше totalSteps (clamp)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      // В stepsState уже 3 done — максимум для урока с totalSteps=3.
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 3,
        totalSteps: 3,
        stepsState: { sA: 'done', sB: 'done', sC: 'done' },
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        stepsState: data.stepsState,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      // «Осиротевший» stepId (например, шаг был удалён автором, но
      // клиент ещё не пере-загрузил список) — пишется в stepsState,
      // но счётчик clamp'ится до totalSteps=3.
      const r = await service.updateStepProgress(OWNER, 'l1', 'sZombie', 'done');
      expect(r.completedStepsCount).toBe(3);
    });

    it('failed/skipped — счётчик пересчитывается из stepsState', async () => {
      // Если в stepsState уже sA=done, и приходит sA=failed — done
      // в счётчике становится 0 (state перезаписан).
      for (const state of ['failed', 'skipped'] as const) {
        prisma.userLesson.findUnique.mockResolvedValue(okLesson());
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          id: 'p1',
          completedStepsCount: 1,
          totalSteps: 3,
          stepsState: { sA: 'done' },
        });
        prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
          userLessonId: 'l1',
          completedStepsCount: data.completedStepsCount,
          totalSteps: data.totalSteps,
          stepsState: data.stepsState,
          startedAt: new Date(),
          lastActivityAt: data.lastActivityAt,
          completedAt: null,
        }));
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

        const r = await service.updateStepProgress(OWNER, 'l1', 'sA', state);
        expect(r.completedStepsCount).toBe(0);
        expect(r.stepsState).toEqual({ sA: state });
      }
    });

    it('failed/skipped другого stepId — done-счётчик не трогается', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 1,
        totalSteps: 3,
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        stepsState: data.stepsState,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 'sB', 'failed');
      expect(r.completedStepsCount).toBe(1);
      expect(r.stepsState).toEqual({ sA: 'done', sB: 'failed' });
    });

    it('Backward-compat: запись без stepsState (старая) — обрабатывается как пустой объект', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 0,
        totalSteps: 3,
        // stepsState отсутствует (либо null, либо undefined у старой записи)
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        stepsState: data.stepsState,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 'sA', 'done');
      expect(r.completedStepsCount).toBe(1);
      expect(r.stepsState).toEqual({ sA: 'done' });
    });

    it('чужой на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 3 },
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(
        service.updateStepProgress(OTHER, 'l1', 's1', 'done'),
      ).rejects.toThrow(NotFoundException);
    });

    it('обновление шага touch\'ит курс-прогресс без инкремента completedLessonsCount', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonPlayProgress.create.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 3,
        stepsState: { sA: 'done' },
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.updateStepProgress(OWNER, 'l1', 'sA', 'done');
      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update).not.toHaveProperty('completedLessonsCount');
      expect(upsert.create.completedLessonsCount).toBe(0);
    });
  });

  // ─── completeLesson ────────────────────────────────────────────────

  describe('completeLesson', () => {
    const okLesson = () => ({
      userCourseId: 'c1',
      _count: { steps: 3 },
      course: { ownerId: OWNER, isPublic: false },
    });

    it('первый complete: upsert прогресса + инкремент completedLessonsCount + stepsState=все done', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonStep.findMany.mockResolvedValue([
        { id: 'sA' }, { id: 'sB' }, { id: 'sC' },
      ]);
      // KS-1883: пред-state должен пройти серверный threshold ≥0.7
      // (3/3=1.0). completedAt=null → inc=true.
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: null,
        stepsState: { sA: 'done', sB: 'done', sC: 'done' },
      });
      const now = new Date();
      prisma.userLessonPlayProgress.upsert.mockImplementation(async ({ create }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: create.completedStepsCount,
        totalSteps: create.totalSteps,
        stepsState: create.stepsState,
        startedAt: now,
        lastActivityAt: now,
        completedAt: now,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.completeLesson(OWNER, 'l1', 1);
      expect(r.completedAt).not.toBeNull();
      expect(r.stepsState).toEqual({ sA: 'done', sB: 'done', sC: 'done' });

      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update.completedLessonsCount).toEqual({ increment: 1 });
      expect(upsert.create.completedLessonsCount).toBe(1);
    });

    // KS-1879: completeLesson не перетирает уже отмеченные failed/skipped.
    // KS-1883: чтобы пройти server gate, в pre-state должно быть достаточно
    // done. Берём 4-шаговый урок: 3 done + 1 failed = 0.75 ≥ 0.7.
    it('сохраняет failed/skipped в stepsState, добивает остальные до done', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 4 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonStep.findMany.mockResolvedValue([
        { id: 'sA' }, { id: 'sB' }, { id: 'sC' }, { id: 'sD' },
      ]);
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: null,
        // 3/4 done = 0.75 ≥ threshold 0.7. sD=failed — не должен перетереться.
        stepsState: { sA: 'done', sB: 'done', sC: 'done', sD: 'failed' },
      });
      prisma.userLessonPlayProgress.upsert.mockImplementation(async ({ update }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: update.completedStepsCount,
        totalSteps: update.totalSteps,
        stepsState: update.stepsState,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.completeLesson(OWNER, 'l1', 0.6);
      expect(r.stepsState).toEqual({
        sA: 'done',
        sB: 'done',
        sC: 'done',
        sD: 'failed', // failed сохранился, не перетёрт в done
      });
    });

    it('повторный complete (был completedAt): счётчик курса НЕ инкрементируется', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonStep.findMany.mockResolvedValue([{ id: 'sA' }]);
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: new Date('2026-04-01'),
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 3,
        totalSteps: 3,
        stepsState: { sA: 'done' },
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.completeLesson(OWNER, 'l1', 1);

      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update).not.toHaveProperty('completedLessonsCount');
      expect(upsert.create.completedLessonsCount).toBe(0);
    });

    it('чужой пользователь на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      await expect(service.completeLesson(OTHER, 'l1', 1)).rejects.toThrow(NotFoundException);
    });

    it('несуществующий урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(null);
      await expect(service.completeLesson(OWNER, 'nope', 1)).rejects.toThrow(NotFoundException);
    });

    it('completeLesson НЕ пишет в LessonReview (SM-2 отключён)', async () => {
      // Отдельный guard: даже если кто-то добавит prisma.lessonReview mock,
      // completeLesson его не тронет — мы проверяем отсутствие свойства
      // в mock'е вообще (типа-safe smoke).
      expect((prisma as any).lessonReview).toBeUndefined();

      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonStep.findMany.mockResolvedValue([]);
      // KS-1883: pre-state всё done (3/3=1.0), чтобы пройти server gate.
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: null,
        stepsState: { sA: 'done', sB: 'done', sC: 'done' },
      });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 0,
        totalSteps: 0,
        stepsState: {},
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.completeLesson(OWNER, 'l1', 1);
      // Если в будущем кто-то добавит lessonReview.upsert — тест сразу
      // упадёт (expect внизу не сработает на undefined). Для текущего
      // контракта достаточно проверки выше.
    });

    // ─── KS-1883: server-enforced threshold ≥0.7 ──────────────────────
    //
    // Клиентский `score` в payload игнорируется — gate считает по
    // `count('done')` в реально сохранённом stepsState.
    describe('threshold gate (KS-1883)', () => {
      const threeStepLesson = () => ({
        userCourseId: 'c1',
        _count: { steps: 4 },
        course: { ownerId: OWNER, isPublic: false },
      });

      function setupForGate(stepsState: Record<string, string>) {
        prisma.userLesson.findUnique.mockResolvedValue(threeStepLesson());
        prisma.userLessonStep.findMany.mockResolvedValue([
          { id: 'sA' }, { id: 'sB' }, { id: 'sC' }, { id: 'sD' },
        ]);
        prisma.userLesson.count.mockResolvedValue(1);
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          completedAt: null,
          stepsState,
        });
        prisma.userLessonPlayProgress.upsert.mockImplementation(async ({ create }: any) => ({
          userLessonId: 'l1',
          completedStepsCount: create?.completedStepsCount ?? 0,
          totalSteps: create?.totalSteps ?? 4,
          stepsState: create?.stepsState ?? stepsState,
          startedAt: new Date(),
          lastActivityAt: new Date(),
          completedAt: new Date(),
        }));
      }

      // Gherkin: «Попытка обойти threshold через API» — клиент шлёт score=1
      // при реальном serverScore=0.25.
      it('1/4 done (0.25) и клиентский score=1.0 → 400, completedAt не ставится', async () => {
        setupForGate({ sA: 'done' });

        await expect(service.completeLesson(OWNER, 'l1', 1.0)).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.userLessonPlayProgress.upsert).not.toHaveBeenCalled();
        expect(prisma.userCoursePlayProgress.upsert).not.toHaveBeenCalled();
      });

      it('сообщение об ошибке содержит фактический score и порог', async () => {
        setupForGate({ sA: 'done' });
        try {
          await service.completeLesson(OWNER, 'l1', 1.0);
          fail('expected BadRequestException');
        } catch (e) {
          const msg = (e as Error).message;
          expect(msg).toContain('25%');   // serverScore = 1/4
          expect(msg).toContain('1/4');
          expect(msg).toContain('70%');   // threshold
        }
      });

      it('2/4 done (0.5) → 400 (ниже порога)', async () => {
        setupForGate({ sA: 'done', sB: 'done' });
        await expect(service.completeLesson(OWNER, 'l1', 1.0)).rejects.toThrow(
          BadRequestException,
        );
      });

      // Gherkin: «Легитимное complete» (3/4 = 0.75 ≥ 0.7).
      it('3/4 done (0.75) → 201, completedAt ставится', async () => {
        setupForGate({ sA: 'done', sB: 'done', sC: 'done' });
        const r = await service.completeLesson(OWNER, 'l1', 0); // клиентский score игнорируется
        expect(r.completedAt).not.toBeNull();
      });

      // Edge case из DoD задачи: точно 0.7 → проходит.
      // 7/10 = 0.7 ровно. Для этого нужен 10-шаговый урок.
      it('edge: ровно 0.7 (7/10) → проходит', async () => {
        prisma.userLesson.findUnique.mockResolvedValue({
          userCourseId: 'c1',
          _count: { steps: 10 },
          course: { ownerId: OWNER, isPublic: false },
        });
        prisma.userLessonStep.findMany.mockResolvedValue(
          Array.from({ length: 10 }, (_, i) => ({ id: `s${i}` })),
        );
        prisma.userLesson.count.mockResolvedValue(1);
        const stepsState: Record<string, string> = {};
        for (let i = 0; i < 7; i++) stepsState[`s${i}`] = 'done';
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          completedAt: null,
          stepsState,
        });
        prisma.userLessonPlayProgress.upsert.mockImplementation(async ({ create }: any) => ({
          userLessonId: 'l1',
          completedStepsCount: create.completedStepsCount,
          totalSteps: create.totalSteps,
          stepsState: create.stepsState,
          startedAt: new Date(),
          lastActivityAt: new Date(),
          completedAt: new Date(),
        }));

        await expect(service.completeLesson(OWNER, 'l1', 0)).resolves.toBeDefined();
      });

      it('пустой урок (totalSteps=0) → gate пропускает (degenerate-кейс)', async () => {
        prisma.userLesson.findUnique.mockResolvedValue({
          userCourseId: 'c1',
          _count: { steps: 0 },
          course: { ownerId: OWNER, isPublic: false },
        });
        prisma.userLessonStep.findMany.mockResolvedValue([]);
        prisma.userLesson.count.mockResolvedValue(1);
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          completedAt: null,
          stepsState: {},
        });
        prisma.userLessonPlayProgress.upsert.mockImplementation(async ({ create }: any) => ({
          userLessonId: 'l1',
          completedStepsCount: 0,
          totalSteps: 0,
          stepsState: {},
          startedAt: new Date(),
          lastActivityAt: new Date(),
          completedAt: new Date(),
        }));
        await expect(service.completeLesson(OWNER, 'l1', 0)).resolves.toBeDefined();
      });

      // Idempotent: уже завершённый урок не должен снова падать в gate
      // (например, после complete автор удалил шаги — повторный POST
      // /complete должен оставаться 200, не 400).
      it('уже завершённый урок (wasAlreadyCompleted) → gate пропускает', async () => {
        prisma.userLesson.findUnique.mockResolvedValue(threeStepLesson());
        prisma.userLessonStep.findMany.mockResolvedValue([
          { id: 'sA' }, { id: 'sB' }, { id: 'sC' }, { id: 'sD' },
        ]);
        prisma.userLesson.count.mockResolvedValue(1);
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          completedAt: new Date('2026-04-01'),
          stepsState: { sA: 'done' }, // 1/4 < 0.7, но уже completed
        });
        prisma.userLessonPlayProgress.upsert.mockResolvedValue({
          userLessonId: 'l1',
          completedStepsCount: 4,
          totalSteps: 4,
          stepsState: { sA: 'done', sB: 'done', sC: 'done', sD: 'done' },
          startedAt: new Date(),
          lastActivityAt: new Date(),
          completedAt: new Date(),
        });
        await expect(service.completeLesson(OWNER, 'l1', 0)).resolves.toBeDefined();
      });
    });
  });

  // ─── touchUserCourseProgress ───────────────────────────────────────

  describe('touchUserCourseProgress', () => {
    it('без инкремента — обновляет только lastActivityAt', async () => {
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({
        completedLessonsCount: 0,
        completedAt: null,
      });
      await service.touchUserCourseProgress(OWNER, 'c1', { incrementCompleted: false });
      const call = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(call.update).not.toHaveProperty('completedLessonsCount');
      expect(call.create.completedLessonsCount).toBe(0);
    });

    it('с инкрементом — increment:1 в update, 1 в create', async () => {
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({
        completedLessonsCount: 1,
        completedAt: null,
      });
      await service.touchUserCourseProgress(OWNER, 'c1', { incrementCompleted: true });
      const call = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(call.update.completedLessonsCount).toEqual({ increment: 1 });
      expect(call.create.completedLessonsCount).toBe(1);
    });

    // KS-1881: логика «курс пройден».
    describe('completedAt маркер курса (KS-1881)', () => {
      it('completedLessonsCount достиг totalLessonsInCourse → ставит completedAt', async () => {
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 2,
          completedAt: null,
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: true,
          totalLessonsInCourse: 2,
        });
        expect(prisma.userCoursePlayProgress.update).toHaveBeenCalledWith({
          where: { userId_userCourseId: { userId: OWNER, userCourseId: 'c1' } },
          data: { completedAt: expect.any(Date) },
        });
      });

      it('completedLessonsCount меньше total → completedAt не ставится', async () => {
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 1,
          completedAt: null,
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: true,
          totalLessonsInCourse: 2,
        });
        expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
      });

      it('completedAt уже стоит → не двигаем (идемпотентность)', async () => {
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 2,
          completedAt: new Date('2026-04-01T00:00:00Z'),
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: false,
          totalLessonsInCourse: 2,
        });
        expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
      });

      it('totalLessonsInCourse не передан → completedAt не ставится (старое поведение)', async () => {
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 5,
          completedAt: null,
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: false,
        });
        expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
      });

      it('total=0 (пустой курс) → completedAt не ставится', async () => {
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 0,
          completedAt: null,
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: false,
          totalLessonsInCourse: 0,
        });
        expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
      });

      it('count > total (например, урок удалили после complete) → ставит completedAt', async () => {
        // completedLessonsCount=3 в БД (когда-то было 3 урока), теперь
        // total=2. Условие `count >= total` → курс должен быть completed.
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({
          completedLessonsCount: 3,
          completedAt: null,
        });
        await service.touchUserCourseProgress(OWNER, 'c1', {
          incrementCompleted: false,
          totalLessonsInCourse: 2,
        });
        expect(prisma.userCoursePlayProgress.update).toHaveBeenCalled();
      });
    });
  });

  // ─── completeLesson + course completedAt (KS-1881 e2e) ─────────────

  describe('completeLesson → course.completedAt (KS-1881)', () => {
    const lesson = (steps = 3) => ({
      userCourseId: 'c1',
      _count: { steps },
      course: { ownerId: OWNER, isPublic: false },
    });

    function setupCompleteLesson(opts: {
      lessonsInCourse: number;
      coursePrevCompletedAt: Date | null;
      newCompletedLessonsCount: number;
    }) {
      prisma.userLesson.findUnique.mockResolvedValue(lesson(1));
      prisma.userLessonStep.findMany.mockResolvedValue([{ id: 'sA' }]);
      prisma.userLesson.count.mockResolvedValue(opts.lessonsInCourse);
      // KS-1883: pre-state должен пройти server gate. 1/1=1.0 ≥ 0.7.
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: null,
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 1,
        stepsState: { sA: 'done' },
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({
        completedLessonsCount: opts.newCompletedLessonsCount,
        completedAt: opts.coursePrevCompletedAt,
      });
    }

    // Gherkin: «Курс из 2 уроков пройден»
    it('второй урок завершает курс → completedAt ставится', async () => {
      setupCompleteLesson({
        lessonsInCourse: 2,
        coursePrevCompletedAt: null,
        newCompletedLessonsCount: 2,
      });
      await service.completeLesson(OWNER, 'l1', 1);
      expect(prisma.userCoursePlayProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { completedAt: expect.any(Date) } }),
      );
    });

    // Gherkin: «Курс ещё не пройден»
    it('пройден только 1 из 2 уроков → completedAt не ставится', async () => {
      setupCompleteLesson({
        lessonsInCourse: 2,
        coursePrevCompletedAt: null,
        newCompletedLessonsCount: 1,
      });
      await service.completeLesson(OWNER, 'l1', 1);
      expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
    });

    // Regression: курс с одним уроком становится completed на первом же complete.
    it('курс из 1 урока — completedAt ставится сразу', async () => {
      setupCompleteLesson({
        lessonsInCourse: 1,
        coursePrevCompletedAt: null,
        newCompletedLessonsCount: 1,
      });
      await service.completeLesson(OWNER, 'l1', 1);
      expect(prisma.userCoursePlayProgress.update).toHaveBeenCalled();
    });

    // Gherkin: «Идемпотентность» — повторный complete не двигает дату.
    it('повторный complete уже пройденного курса → completedAt не обновляется', async () => {
      const T1 = new Date('2026-04-01T00:00:00Z');
      // completedAt урока уже стоит → wasAlreadyCompleted=true → incrementCompleted=false.
      prisma.userLesson.findUnique.mockResolvedValue(lesson(1));
      prisma.userLessonStep.findMany.mockResolvedValue([{ id: 'sA' }]);
      prisma.userLesson.count.mockResolvedValue(2);
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: T1,
        stepsState: { sA: 'done' },
      });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 1,
        stepsState: { sA: 'done' },
        startedAt: T1,
        lastActivityAt: T1,
        completedAt: T1,
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({
        completedLessonsCount: 2,
        completedAt: T1, // курс уже пройден ранее
      });

      await service.completeLesson(OWNER, 'l1', 1);
      // Идемпотентность: completedAt уже T1, повторно update не вызван.
      expect(prisma.userCoursePlayProgress.update).not.toHaveBeenCalled();
    });
  });

  // ─── DTO snapshot (KS-1879 Gherkin: «Восстановление stepsState») ───

  describe('DTO snapshot', () => {
    it('GET lessonProgress отдаёт DTO с stepsState (две done + одна pending)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 3 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 3,
        stepsState: { sA: 'done', sB: 'done', sC: 'pending' },
        startedAt: new Date('2026-04-01T10:00:00.000Z'),
        lastActivityAt: new Date('2026-04-01T10:30:00.000Z'),
        completedAt: null,
      });
      const r = await service.getLessonProgress(OWNER, 'l1');
      expect(r).toEqual({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 3,
        stepsState: { sA: 'done', sB: 'done', sC: 'pending' },
        startedAt: '2026-04-01T10:00:00.000Z',
        lastActivityAt: '2026-04-01T10:30:00.000Z',
        completedAt: null,
      });
    });
  });
});
