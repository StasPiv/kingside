/**
 * KS-2815 / KS-2822 T7 + KS-2860 (B4). Unit-тесты guards Studies:
 *   - StudyAccessGuard — чтение с учётом visibility + members.
 *   - StudyOwnerGuard — мутации только owner.
 *   - StudyContributorGuard — мутации owner либо contributor.
 *
 * Prisma — мок; StudyMembersService — мок (через `getRole`).
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  STUDY_RESOURCE_KEY,
  StudyAccessGuard,
  StudyResourceKind,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { StudyContributorGuard } from './study-contributor.guard';
import type { StudyMembersService } from './study-members.service';
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

function makeMembers(role: 'owner' | 'contributor' | null): StudyMembersService {
  return {
    getRole: jest.fn(async () => role),
  } as unknown as StudyMembersService;
}

describe('StudyAccessGuard — KS-2860 B4 (visibility + members)', () => {
  function makeGuard(opts: {
    studyRow: { id: string; ownerId: string; visibility: string } | null;
    role: 'owner' | 'contributor' | null;
  }) {
    const prisma = {
      study: {
        findFirst: jest.fn(async () => opts.studyRow),
      },
    } as unknown as PrismaService;
    return new StudyAccessGuard(
      prisma,
      makeReflector('study-slug'),
      makeMembers(opts.role),
    );
  }

  it('public — anonymous → разрешает', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'public' },
      role: null,
    });
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('unlisted — anonymous → разрешает (по прямой ссылке)', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'unlisted' },
      role: null,
    });
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('private + anonymous → 404', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'private' },
      role: null,
    });
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('private + owner → разрешает (даже без members-record)', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'private' },
      role: null,
    });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('private + contributor → разрешает', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'private' },
      role: 'contributor',
    });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u2', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('private + outsider (не member) → 404', async () => {
    const guard = makeGuard({
      studyRow: { id: 's1', ownerId: 'u1', visibility: 'private' },
      role: null,
    });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u2', params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chapter-id → резолвит через study (visibility=public) → разрешает', async () => {
    const prisma = {
      studyChapter: {
        findUnique: jest.fn(async () => ({
          study: { id: 's1', ownerId: 'u1', visibility: 'public' },
        })),
      },
    } as unknown as PrismaService;
    const guard = new StudyAccessGuard(
      prisma,
      makeReflector('chapter-id'),
      makeMembers(null),
    );
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
    const guard = new StudyAccessGuard(
      prisma,
      makeReflector('chapter-id'),
      makeMembers(null),
    );
    await expect(
      guard.canActivate(
        makeCtx({ userId: 'u1', params: { chapterId: 'ch' } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('без @StudyResource → бросает Error', async () => {
    const prisma = {} as PrismaService;
    const guard = new StudyAccessGuard(
      prisma,
      makeReflector(undefined),
      makeMembers(null),
    );
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

  it('non-owner → 404 (findFirst({ownerId:userId,slug}) returns null)', async () => {
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

describe('StudyContributorGuard — KS-2860 B4', () => {
  function makeGuard(opts: {
    studyId: string | null;
    role: 'owner' | 'contributor' | null;
    kind?: StudyResourceKind;
  }) {
    const prisma = {
      study: {
        findFirst: jest.fn(async () =>
          opts.studyId ? { id: opts.studyId } : null,
        ),
      },
      studyChapter: {
        findUnique: jest.fn(async () =>
          opts.studyId ? { studyId: opts.studyId } : null,
        ),
      },
    } as unknown as PrismaService;
    return new StudyContributorGuard(
      prisma,
      makeReflector(opts.kind ?? 'study-slug'),
      makeMembers(opts.role),
    );
  }

  it('owner → разрешает', async () => {
    const guard = makeGuard({ studyId: 's1', role: 'owner' });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('contributor → разрешает', async () => {
    const guard = makeGuard({ studyId: 's1', role: 'contributor' });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u2', params: { slug: 'x' } })),
    ).resolves.toBe(true);
  });

  it('outsider (не member) → 404', async () => {
    const guard = makeGuard({ studyId: 's1', role: null });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u3', params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('anonymous → 404', async () => {
    const guard = makeGuard({ studyId: 's1', role: null });
    await expect(
      guard.canActivate(makeCtx({ userId: null, params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('несуществующая студия → 404', async () => {
    const guard = makeGuard({ studyId: null, role: 'owner' });
    await expect(
      guard.canActivate(makeCtx({ userId: 'u1', params: { slug: 'x' } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chapter-id contributor → разрешает', async () => {
    const guard = makeGuard({
      studyId: 's1',
      role: 'contributor',
      kind: 'chapter-id',
    });
    await expect(
      guard.canActivate(
        makeCtx({ userId: 'u2', params: { chapterId: 'ch' } }),
      ),
    ).resolves.toBe(true);
  });
});
