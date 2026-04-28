/**
 * KS-2108 — `AdminUserGuard` + `AdminUserService` + `parseAdminUsers`.
 */
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  AdminUserGuard,
  AdminUserService,
  parseAdminUsers,
} from './admin-user.guard';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';

function makeCtx(userId: string | undefined): ExecutionContext {
  const req = userId ? { user: { id: userId } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeConfig(envValue: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === 'KS_ADMIN_USERS' ? envValue : undefined),
  } as unknown as ConfigService;
}

function makePrisma(username: string | null): PrismaService {
  return {
    user: {
      findUnique: jest.fn(async () => (username !== null ? { username } : null)),
    },
  } as unknown as PrismaService;
}

describe('parseAdminUsers', () => {
  it('пустой/undefined → []', () => {
    expect(parseAdminUsers(undefined)).toEqual([]);
    expect(parseAdminUsers('')).toEqual([]);
    expect(parseAdminUsers('   ')).toEqual([]);
  });

  it('CSV → нормализованный lowercase массив', () => {
    expect(parseAdminUsers(' Alice , Bob , ')).toEqual(['alice', 'bob']);
    expect(parseAdminUsers('StanislavTelegram')).toEqual(['stanislavtelegram']);
  });

  it('пустые элементы фильтруются', () => {
    expect(parseAdminUsers('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('AdminUserGuard — KS-2108', () => {
  it('без req.user → UnauthorizedException', async () => {
    const guard = new AdminUserGuard(
      makePrisma('whatever'),
      makeConfig('Alice'),
    );
    await expect(guard.canActivate(makeCtx(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('пустой whitelist → Forbidden', async () => {
    const guard = new AdminUserGuard(makePrisma('Alice'), makeConfig(''));
    await expect(guard.canActivate(makeCtx('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('username в whitelist → allow (case-insensitive)', async () => {
    const guard = new AdminUserGuard(
      makePrisma('StanislavTelegram'),
      makeConfig('StanislavTelegram'),
    );
    await expect(guard.canActivate(makeCtx('u1'))).resolves.toBe(true);
  });

  it('username отличается от whitelist → Forbidden', async () => {
    const guard = new AdminUserGuard(
      makePrisma('Alice'),
      makeConfig('StanislavTelegram'),
    );
    await expect(guard.canActivate(makeCtx('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('whitelist=*  → allow всех аутентифицированных', async () => {
    const guard = new AdminUserGuard(makePrisma('any'), makeConfig('*'));
    await expect(guard.canActivate(makeCtx('u1'))).resolves.toBe(true);
  });

  it('username=null (пользователь без username) → Forbidden', async () => {
    const guard = new AdminUserGuard(makePrisma(null), makeConfig('Alice'));
    await expect(guard.canActivate(makeCtx('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('AdminUserService.isAdmin — KS-2108', () => {
  it('пустой whitelist → false (без 403)', async () => {
    const svc = new AdminUserService(makePrisma('Alice'), makeConfig(''));
    expect(await svc.isAdmin('u1')).toBe(false);
  });

  it('username в whitelist → true', async () => {
    const svc = new AdminUserService(
      makePrisma('StanislavTelegram'),
      makeConfig('StanislavTelegram,Other'),
    );
    expect(await svc.isAdmin('u1')).toBe(true);
  });

  it('whitelist=* → true', async () => {
    const svc = new AdminUserService(makePrisma('any'), makeConfig('*'));
    expect(await svc.isAdmin('u1')).toBe(true);
  });

  it('пользователь не в whitelist → false', async () => {
    const svc = new AdminUserService(
      makePrisma('Alice'),
      makeConfig('Bob,Charlie'),
    );
    expect(await svc.isAdmin('u1')).toBe(false);
  });

  it('username=null → false', async () => {
    const svc = new AdminUserService(makePrisma(null), makeConfig('Alice'));
    expect(await svc.isAdmin('u1')).toBe(false);
  });
});
