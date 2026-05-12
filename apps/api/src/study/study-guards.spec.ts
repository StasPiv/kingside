/**
 * KS-2815 / KS-2822 T7. Unit-тесты `StudyAccessGuard` / `StudyOwnerGuard`
 * с реальной логикой (Prisma — мок). Покрывают:
 *  - 'study-slug' (resolve через `studies` table);
 *  - 'chapter-id' (resolve через `study_chapters → study`);
 *  - owner / anonymous / другой пользователь / public / private.
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  STUDY_RESOURCE_KEY,
  StudyAccessGuard,
  StudyResourceKind,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import type { PrismaService } from '../prisma/prisma.service';

function makeCtx({
  userId,
  params,
}: {
  userId: string | null;
  params: Record<string, string>;
}): ExecutionContext {
  return {
    getHandler: () => 'h',
    getClass: () => 'c',
    switchToHttp: () => ({
      getRequest: () => ({
        user: userId ? { id: userId } : undefined,
        params,
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeReflector(kind: StudyResourceKind | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === STUDY_RESOURCE_KEY ? kind : undefined,
    ),
  } as unknown as Reflector;
}

describe('StudyAccessGuard — KS-2822 T7', () => {
  it('owner private → разрешает', async () => {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => ({ ownerId: 'u1', isPublic: false })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('anonymous public → разрешает', async () => {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => ({ ownerId: 'u1', isPublic: true })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('anonymous private → 404', async () => {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => ({ ownerId: 'u1', isPublic: false })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('другой пользователь private → 404', async () => {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => ({ ownerId: 'u1', isPublic: false })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: 'u2', params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chapter-id → резолвит через study', async () => {
    const prisma = {
      studyChapter: {
        findUnique: jest.fn(async () => ({
          study: { ownerId: 'u1', isPublic: true },
        })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('chapter-id'));
    await expect(
      guard.canActivate(
        makeCtx({ userId: null, params: { chapterId: 'ch' } }),
      ),
    ).resolves.toBe(true);
  });

  it('chapter-id несуществующий → 404', async () => {
    const prisma = {
      studyChapter: {
        findUnique: jest.fn(async () => null),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector('chapter-id'));
    await expect(
      guard.canActivate(
        makeCtx({ userId: 'u1', params: { chapterId: 'ch' } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('без @StudyResource → бросает Error (защита от misconfiguration)', async () => {
    const prisma = {} as PrismaService;
    const guard = new StudyAccessGuard(prisma, makeReflector(undefined));
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: {} })),
    ).rejects.toThrow(/decorator/);
  });
});

describe('StudyOwnerGuard — KS-2822 T7', () => {
  it('owner → разрешает', async () => {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => ({ ownerId: 'u1' })),
      },
    } as unknown as PrismaService;
    const guard = new StudyOwnerGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('non-owner (другой user) → 404', async () => {
    // findFirst({ ownerId: userId, slug }) для чужого вернёт null →
    // resolveOwnerId вернёт null → ownerId !== userId → 404.
    const prisma = {
      study: {
        findFirst: jest.fn(async () => null),
      },
    } as unknown as PrismaService;
    const guard = new StudyOwnerGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: 'u2', params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('anonymous → 404', async () => {
    const prisma = {} as PrismaService;
    const guard = new StudyOwnerGuard(prisma, makeReflector('study-slug'));
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chapter-id owner через JOIN → разрешает', async () => {
    const prisma = {
      studyChapter: {
        findUnique: jest.fn(async () => ({ study: { ownerId: 'u1' } })),
      },
    } as unknown as PrismaService;
    const guard = new StudyOwnerGuard(prisma, makeReflector('chapter-id'));
    await expect(
      guard.canActivate(
        makeCtx({ userId: 'u1', params: { chapterId: 'ch' } }),
      ),
    ).resolves.toBe(true);
  });

  it('chapter-id non-owner → 404', async () => {
    const prisma = {
      studyChapter: {
        findUnique: jest.fn(async () => ({ study: { ownerId: 'u1' } })),
      },
    } as unknown as PrismaService;
    const guard = new StudyOwnerGuard(prisma, makeReflector('chapter-id'));
    await expect(
      guard.canActivate(
        makeCtx({ userId: 'u2', params: { chapterId: 'ch' } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
