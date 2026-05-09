/**
 * KS-2642 / ADR-054 §3.4 Phase C — юнит-тесты `LessonsAccessGuard`.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LessonsAccessGuard, LessonsResource } from './lessons-access.guard';
import type { PrismaService } from '../prisma/prisma.service';

interface FakeContext {
  switchToHttp(): { getRequest(): unknown };
  getHandler(): unknown;
}

function makeContext(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  user?: { id: string; isAdmin?: boolean } | null;
  params?: Record<string, string>;
  resourceKind?: 'course' | 'course-slug' | 'lesson' | 'step';
}): { context: FakeContext; reflector: Reflector } {
  const handler: object = {};
  const reflector = new Reflector();
  if (opts.resourceKind) {
    Reflect.defineMetadata('adr054.lessons-resource', opts.resourceKind, handler);
  }
  const context: FakeContext = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method,
        user: opts.user ?? null,
        params: opts.params ?? {},
      }),
    }),
    getHandler: () => handler,
  };
  return { context, reflector };
}

function makePrisma(opts: {
  course?: Record<string, unknown> | null;
  courseFirst?: Record<string, unknown> | null;
  courseFirstAlt?: Record<string, unknown> | null;
  lesson?: Record<string, unknown> | null;
  step?: Record<string, unknown> | null;
}): PrismaService {
  let firstCallNum = 0;
  return {
    course: {
      findUnique: jest.fn().mockResolvedValue(opts.course ?? null),
      findFirst: jest.fn().mockImplementation(async () => {
        firstCallNum++;
        if (firstCallNum === 1) return opts.courseFirst ?? null;
        return opts.courseFirstAlt ?? null;
      }),
    },
    lesson: {
      findUnique: jest.fn().mockResolvedValue(opts.lesson ?? null),
    },
    lessonStep: {
      findUnique: jest.fn().mockResolvedValue(opts.step ?? null),
    },
  } as unknown as PrismaService;
}

describe('LessonsAccessGuard — KS-2642', () => {
  describe('без декоратора @LessonsResource — пропускает', () => {
    it('canActivate=true, БД не дёргается', async () => {
      const { context, reflector } = makeContext({ method: 'GET' });
      const prisma = makePrisma({});
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });
  });

  describe('course read', () => {
    it('системный isPublished=true → разрешён аноним', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: null, isPublic: false, isPublished: true },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });

    it('системный isPublished=false и не owner → 404', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: null, isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('пользовательский isPublic=true → разрешён любому залогиненному', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u-other' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: 'u1', isPublic: true, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });

    it('пользовательский isPublic=false, не owner → 404 (не раскрываем существование)', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u-other' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: 'u1', isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('пользовательский isPublic=false, owner → разрешён', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: 'u1', isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });
  });

  describe('course write (POST/PATCH/DELETE)', () => {
    it('системный, admin → разрешён', async () => {
      const { context, reflector } = makeContext({
        method: 'PATCH',
        user: { id: 'admin', isAdmin: true },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: null, isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });

    it('системный, не admin → 403', async () => {
      const { context, reflector } = makeContext({
        method: 'PATCH',
        user: { id: 'u1' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: null, isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('пользовательский, owner → разрешён', async () => {
      const { context, reflector } = makeContext({
        method: 'DELETE',
        user: { id: 'u1' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: 'u1', isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });

    it('пользовательский, не owner → 403', async () => {
      const { context, reflector } = makeContext({
        method: 'DELETE',
        user: { id: 'u-other' },
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({
        course: { ownerId: 'u1', isPublic: true, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('course-slug', () => {
    it('сначала проверяет системный namespace (ownerId IS NULL)', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { slug: 'beginner' },
        resourceKind: 'course-slug',
      });
      const prisma = makePrisma({
        courseFirst: { ownerId: null, isPublic: false, isPublished: true },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });

    it('системный не нашёлся → ищет в namespace владельца, owner=user → разрешён', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { slug: 'private' },
        resourceKind: 'course-slug',
      });
      const prisma = makePrisma({
        courseFirst: null,
        courseFirstAlt: { ownerId: 'u1', isPublic: false, isPublished: false },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });
  });

  describe('lesson read — наследует isPublic от course', () => {
    it('lesson без course relation → 404', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u1' },
        params: { id: 'L1' },
        resourceKind: 'lesson',
      });
      const prisma = makePrisma({ lesson: null });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lesson курса с isPublic=true → разрешён', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: { id: 'u-other' },
        params: { id: 'L1' },
        resourceKind: 'lesson',
      });
      const prisma = makePrisma({
        lesson: {
          ownerId: 'u1',
          isPublished: false,
          course: { isPublic: true },
        },
      });
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    });
  });

  describe('без user → 403', () => {
    it('canActivate бросает ForbiddenException если нет req.user', async () => {
      const { context, reflector } = makeContext({
        method: 'GET',
        user: null,
        params: { id: 'c1' },
        resourceKind: 'course',
      });
      const prisma = makePrisma({});
      const guard = new LessonsAccessGuard(reflector, prisma);
      await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
