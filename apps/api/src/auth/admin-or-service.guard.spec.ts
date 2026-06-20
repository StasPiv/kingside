/**
 * KS-4455 / ADR-139 §3. Юнит-тесты `AdminOrServiceGuard`.
 *
 * Все три внутренних гарда подменены mock'ами — composite-логика
 * проверяется на чистых `canActivate`-ответах, а не через реальные
 * JWT/Prisma.
 */
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminOrServiceGuard } from './admin-or-service.guard';
import { REQUIRED_SCOPE_METADATA } from './required-scope.decorator';

function makeCtx(reqUser?: { isServiceAccount?: boolean; scopes?: string[] }): ExecutionContext {
  const req = { user: reqUser };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => null,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeReflector(scope?: string): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === REQUIRED_SCOPE_METADATA) return scope;
      return undefined;
    }),
  } as unknown as Reflector;
}

function mockGuard(behavior: { result?: boolean; throws?: Error } = {}) {
  return {
    canActivate: jest.fn(async () => {
      if (behavior.throws) throw behavior.throws;
      return behavior.result ?? false;
    }),
  };
}

describe('AdminOrServiceGuard', () => {
  it('service-account прошёл (без required scope) → true', async () => {
    const svc = mockGuard({ result: true });
    const jwt = mockGuard();
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector(),
    );
    const ok = await guard.canActivate(
      makeCtx({ isServiceAccount: true, scopes: [] }),
    );
    expect(ok).toBe(true);
    expect(jwt.canActivate).not.toHaveBeenCalled();
    expect(admin.canActivate).not.toHaveBeenCalled();
  });

  it('service-account прошёл + scope matches → true', async () => {
    const svc = mockGuard({ result: true });
    const jwt = mockGuard();
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector('blog:write'),
    );
    const ok = await guard.canActivate(
      makeCtx({ isServiceAccount: true, scopes: ['blog:write', 'blog:read'] }),
    );
    expect(ok).toBe(true);
  });

  it('service-account прошёл + wildcard покрывает scope → true', async () => {
    const svc = mockGuard({ result: true });
    const jwt = mockGuard();
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector('blog:write'),
    );
    const ok = await guard.canActivate(
      makeCtx({ isServiceAccount: true, scopes: ['blog:*'] }),
    );
    expect(ok).toBe(true);
  });

  it('service-account прошёл, scope не покрыт → 403', async () => {
    const svc = mockGuard({ result: true });
    const jwt = mockGuard();
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector('blog:write'),
    );
    await expect(
      guard.canActivate(
        makeCtx({ isServiceAccount: true, scopes: ['lessons:*'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('service-account вернул false (не ks_sa_) → JWT+admin цепочка', async () => {
    const svc = mockGuard({ result: false });
    const jwt = mockGuard({ result: true });
    const admin = mockGuard({ result: true });
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector(),
    );
    const ok = await guard.canActivate(makeCtx());
    expect(ok).toBe(true);
    expect(jwt.canActivate).toHaveBeenCalled();
    expect(admin.canActivate).toHaveBeenCalled();
  });

  it('JWT-admin прошёл, scope игнорируется (human может всё)', async () => {
    const svc = mockGuard({ result: false });
    const jwt = mockGuard({ result: true });
    const admin = mockGuard({ result: true });
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector('blog:write'),
    );
    const ok = await guard.canActivate(makeCtx());
    expect(ok).toBe(true);
  });

  it('service-account бросает 401 → 401 (не уходит в JWT-цепочку)', async () => {
    const svc = mockGuard({
      throws: new UnauthorizedException('Invalid service-account token'),
    });
    const jwt = mockGuard({ result: true });
    const admin = mockGuard({ result: true });
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector(),
    );
    await expect(guard.canActivate(makeCtx())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwt.canActivate).not.toHaveBeenCalled();
    expect(admin.canActivate).not.toHaveBeenCalled();
  });

  it('JWT бросает 401 → 401', async () => {
    const svc = mockGuard({ result: false });
    const jwt = mockGuard({ throws: new UnauthorizedException() });
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector(),
    );
    await expect(guard.canActivate(makeCtx())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('JWT прошёл, AdminUserGuard бросает 403 → 403', async () => {
    const svc = mockGuard({ result: false });
    const jwt = mockGuard({ result: true });
    const admin = mockGuard({ throws: new ForbiddenException('not admin') });
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector(),
    );
    await expect(guard.canActivate(makeCtx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('service-account прошёл, но req.user.scopes отсутствует + required → 403', async () => {
    const svc = mockGuard({ result: true });
    const jwt = mockGuard();
    const admin = mockGuard();
    const guard = new AdminOrServiceGuard(
      svc as never,
      jwt as never,
      admin as never,
      makeReflector('blog:write'),
    );
    await expect(
      guard.canActivate(makeCtx({ isServiceAccount: true })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
