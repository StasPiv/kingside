import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { AdminEmailGuard, parseAdminEmails } from './admin-email.guard';

describe('parseAdminEmails (KS-1963)', () => {
  it('undefined / пустая строка → []', () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
    expect(parseAdminEmails('   ')).toEqual([]);
  });

  it('CSV → нормализованный массив (trim + lowercase, без пустых)', () => {
    expect(parseAdminEmails('A@X.com, b@y.com ,  ,c@z.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
  });

  it('одиночный *', () => {
    expect(parseAdminEmails('*')).toEqual(['*']);
  });
});

describe('AdminEmailGuard (KS-1963)', () => {
  let prisma: { user: { findUnique: jest.Mock } };
  let guard: AdminEmailGuard;
  const ENV_KEY = 'LESSON_ADMIN_EMAILS';
  const originalEnv = process.env[ENV_KEY];

  function buildContext(userId: string | null | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () =>
          userId === undefined ? {} : { user: userId === null ? null : { id: userId } },
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    guard = new AdminEmailGuard(prisma as never);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  // ─── Auth precondition ─────────────────────────────────────────────

  it('без req.user → UnauthorizedException (JwtAuthGuard должен отработать раньше)', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app';
    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // ─── ENV пустая → deny ─────────────────────────────────────────────

  it('ENV не задана → Forbidden ("Admin access disabled")', async () => {
    delete process.env[ENV_KEY];
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('ENV = "" → Forbidden', async () => {
    process.env[ENV_KEY] = '';
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('ENV = "  ,  " (одни запятые-пробелы) → Forbidden', async () => {
    process.env[ENV_KEY] = '  ,  ';
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // ─── Wildcard → allow всех ─────────────────────────────────────────

  it('ENV = "*" → allow без подгрузки email из БД (dev wildcard)', async () => {
    process.env[ENV_KEY] = '*';
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('ENV = "x@y.com,*,z@w.com" — wildcard в списке тоже триггерится', async () => {
    process.env[ENV_KEY] = 'x@y.com,*,z@w.com';
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // ─── Конкретные email (case-insensitive) ───────────────────────────

  it('email пользователя точно в whitelist → allow', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app, foo@bar.com';
    prisma.user.findUnique.mockResolvedValue({ email: 'admin@kingside.app' });
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { email: true },
    });
  });

  it('email пользователя в верхнем регистре, в ENV — в нижнем → allow', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app';
    prisma.user.findUnique.mockResolvedValue({ email: 'Admin@KingSide.App' });
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('email в ENV в верхнем регистре, у пользователя в нижнем → allow', async () => {
    process.env[ENV_KEY] = 'ADMIN@KINGSIDE.APP';
    prisma.user.findUnique.mockResolvedValue({ email: 'admin@kingside.app' });
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('email пользователя НЕ в whitelist → Forbidden', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app, foo@bar.com';
    prisma.user.findUnique.mockResolvedValue({ email: 'random@user.com' });
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('у пользователя нет email в БД (NULL) → Forbidden', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app';
    prisma.user.findUnique.mockResolvedValue({ email: null });
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('пользователь не найден в БД → Forbidden', async () => {
    process.env[ENV_KEY] = 'admin@kingside.app';
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(buildContext('u1'))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
