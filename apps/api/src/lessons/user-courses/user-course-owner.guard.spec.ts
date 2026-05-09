import { ExecutionContext, NotFoundException } from '@nestjs/common';
import {
  UserCourseOwnerGuard,
  UserCourseResource,
  UserCourseResourceKind,
  USER_COURSE_RESOURCE_KEY,
} from './user-course-owner.guard';

describe('UserCourseOwnerGuard (KS-1829)', () => {
  let guard: UserCourseOwnerGuard;
  let prisma: any;
  let reflector: { getAllAndOverride: jest.Mock };

  const OWNER = 'owner-uuid';
  const OUTSIDER = 'someone-else';
  const COURSE_ID = 'course-uuid';

  const mockContext = (args: {
    userId?: string | null;
    method?: string;
    params?: Record<string, string>;
  }) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user: args.userId ? { id: args.userId, username: 'u' } : undefined,
          method: args.method ?? 'GET',
          params: args.params ?? {},
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    prisma = {
      course: { findUnique: jest.fn(), findFirst: jest.fn() },
      lesson: { findUnique: jest.fn() },
      lessonStep: { findUnique: jest.fn() },
    };
    reflector = { getAllAndOverride: jest.fn() };
    guard = new UserCourseOwnerGuard(prisma, reflector as any);
  });

  const useKind = (kind: UserCourseResourceKind) =>
    reflector.getAllAndOverride.mockReturnValue(kind);

  // ─── Misconfiguration ──────────────────────────────────────────────

  it('без @UserCourseResource — кидает ошибку (misconfig)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(
      guard.canActivate(mockContext({ userId: OWNER, params: { id: COURSE_ID } })),
    ).rejects.toThrow(/UserCourseResource/);
  });

  it('без req.user → 404', async () => {
    useKind('course');
    await expect(
      guard.canActivate(mockContext({ userId: null, params: { id: COURSE_ID } })),
    ).rejects.toThrow(NotFoundException);
  });

  it('если в params нет нужного поля — 404', async () => {
    useKind('course');
    await expect(
      guard.canActivate(mockContext({ userId: OWNER, params: {} })),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── Resource: course (by id) ──────────────────────────────────────

  describe('resource=course', () => {
    it('owner видит свой приватный курс', async () => {
      useKind('course');
      prisma.course.findUnique.mockResolvedValue({
        ownerId: OWNER,
        isPublic: false,
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OWNER, params: { id: COURSE_ID } }),
        ),
      ).resolves.toBe(true);
    });

    it('чужой на приватный курс — 404', async () => {
      useKind('course');
      prisma.course.findUnique.mockResolvedValue({
        ownerId: OWNER,
        isPublic: false,
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OUTSIDER, params: { id: COURSE_ID } }),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('чужой на GET публичный курс — 200', async () => {
      useKind('course');
      prisma.course.findUnique.mockResolvedValue({
        ownerId: OWNER,
        isPublic: true,
      });
      await expect(
        guard.canActivate(
          mockContext({
            userId: OUTSIDER,
            method: 'GET',
            params: { id: COURSE_ID },
          }),
        ),
      ).resolves.toBe(true);
    });

    it('чужой на POST/PATCH/DELETE публичный курс — всё равно 404', async () => {
      useKind('course');
      prisma.course.findUnique.mockResolvedValue({
        ownerId: OWNER,
        isPublic: true,
      });
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        await expect(
          guard.canActivate(
            mockContext({
              userId: OUTSIDER,
              method,
              params: { id: COURSE_ID },
            }),
          ),
        ).rejects.toThrow(NotFoundException);
      }
    });

    it('несуществующий курс — 404 (не 500)', async () => {
      useKind('course');
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(
        guard.canActivate(
          mockContext({ userId: OWNER, params: { id: COURSE_ID } }),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Resource: course-slug ─────────────────────────────────────────

  describe('resource=course-slug', () => {
    it('owner по slug — ok', async () => {
      useKind('course-slug');
      // KS-2649: guard теперь использует findFirst (partial-unique
      // namespace `WHERE ownerId IS NOT NULL`).
      prisma.course.findFirst.mockResolvedValue({
        ownerId: OWNER,
        isPublic: false,
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OWNER, params: { slug: 'abc-my' } }),
        ),
      ).resolves.toBe(true);
      expect(prisma.course.findFirst).toHaveBeenCalledWith({
        where: { slug: 'abc-my', ownerId: { not: null } },
        select: { ownerId: true, isPublic: true },
      });
    });

    it('чужой по slug на публичный — GET разрешён', async () => {
      useKind('course-slug');
      prisma.course.findFirst.mockResolvedValue({
        ownerId: OWNER,
        isPublic: true,
      });
      await expect(
        guard.canActivate(
          mockContext({
            userId: OUTSIDER,
            method: 'GET',
            params: { slug: 'abc-my' },
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  // ─── Resource: lesson ──────────────────────────────────────────────

  describe('resource=lesson', () => {
    it('owner урока (через course.ownerId) — ok', async () => {
      useKind('lesson');
      prisma.lesson.findUnique.mockResolvedValue({
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OWNER, params: { id: 'lesson-uuid' } }),
        ),
      ).resolves.toBe(true);
    });

    it('чужой на приватный урок — 404', async () => {
      useKind('lesson');
      prisma.lesson.findUnique.mockResolvedValue({
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OUTSIDER, params: { id: 'lesson-uuid' } }),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Resource: step ────────────────────────────────────────────────

  describe('resource=step', () => {
    it('owner шага (через lesson.course.ownerId) — ok', async () => {
      useKind('step');
      prisma.lessonStep.findUnique.mockResolvedValue({
        lesson: { course: { ownerId: OWNER, isPublic: false } },
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OWNER, params: { id: 'step-uuid' } }),
        ),
      ).resolves.toBe(true);
    });

    it('чужой на шаг — 404', async () => {
      useKind('step');
      prisma.lessonStep.findUnique.mockResolvedValue({
        lesson: { course: { ownerId: OWNER, isPublic: false } },
      });
      await expect(
        guard.canActivate(
          mockContext({ userId: OUTSIDER, params: { id: 'step-uuid' } }),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Декоратор корректно выставляет метадату ───────────────────────

  it('декоратор @UserCourseResource прокидывает kind в reflector-metadata', () => {
    class Handler {}
    const decorator = UserCourseResource('lesson');
    decorator(Handler);
    // SetMetadata добавляет скрытое поле с ключом; проверяем через Reflect.
    const reflectKey = Reflect.getMetadata(USER_COURSE_RESOURCE_KEY, Handler);
    expect(reflectKey).toBe('lesson');
  });
});
