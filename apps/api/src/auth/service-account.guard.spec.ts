/**
 * KS-4454 / ADR-139. Юнит-тесты `ServiceAccountGuard`.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  ServiceAccountGuard,
  extractBearerToken,
  sha256Hex,
  SERVICE_ACCOUNT_PREFIX,
} from './service-account.guard';

function makeCtx(headers: Record<string, unknown>): ExecutionContext {
  const req: { headers: Record<string, unknown>; user?: unknown } = {
    headers,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    // helper: чтобы тест читал req после canActivate.
    _req: req,
  } as unknown as ExecutionContext & { _req: typeof req };
}

function makePrisma(
  account: {
    id: string;
    handle: string;
    scopes: string[];
  } | null,
  opts: { updateThrows?: boolean } = {},
) {
  return {
    agentServiceAccount: {
      findFirst: jest.fn().mockResolvedValue(account),
      update: jest.fn().mockImplementation(async () => {
        if (opts.updateThrows) throw new Error('db down');
        return undefined;
      }),
    },
  };
}

describe('extractBearerToken', () => {
  it('Bearer <token> → токен', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });
  it('case-insensitive схема', () => {
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
  });
  it('trim trailing spaces', () => {
    expect(extractBearerToken('Bearer t   ')).toBe('t');
  });
  it('пустой токен → null', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
  it('нет схемы → null', () => {
    expect(extractBearerToken('just-a-token')).toBeNull();
  });
  it('не строка → null', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(42 as unknown)).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('детерминирован', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
  });
  it('разный вход → разный хеш', () => {
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});

describe('ServiceAccountGuard.canActivate', () => {
  const PLAIN_TOKEN = `${SERVICE_ACCOUNT_PREFIX}live-token-123`;
  const HASH = sha256Hex(PLAIN_TOKEN);

  it('валидный ks_sa_-токен → true + req.user заполнен', async () => {
    const prisma = makePrisma({
      id: 'acc-id',
      handle: 'agent-backend',
      scopes: ['blog:write', 'blog:read'],
    });
    const guard = new ServiceAccountGuard(prisma as never);
    const ctx = makeCtx({ authorization: `Bearer ${PLAIN_TOKEN}` });

    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);

    expect(prisma.agentServiceAccount.findFirst).toHaveBeenCalledWith({
      where: { tokenHash: HASH, revokedAt: null },
      select: { id: true, handle: true, scopes: true },
    });
    // req.user заполнен.
    const req = (ctx as unknown as { _req: { user?: unknown } })._req;
    expect(req.user).toEqual({
      id: 'acc-id',
      username: 'agent-backend',
      isServiceAccount: true,
      scopes: ['blog:write', 'blog:read'],
    });
  });

  it('lastUsedAt обновляется (fire-and-forget)', async () => {
    const prisma = makePrisma({
      id: 'acc-id',
      handle: 'a',
      scopes: [],
    });
    const guard = new ServiceAccountGuard(prisma as never);
    await guard.canActivate(makeCtx({ authorization: `Bearer ${PLAIN_TOKEN}` }));
    // Дать микротаску с update выполниться.
    await new Promise((r) => setImmediate(r));
    expect(prisma.agentServiceAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-id' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('lastUsedAt update бросает → запрос не падает (fire-and-forget)', async () => {
    const prisma = makePrisma(
      { id: 'acc-id', handle: 'a', scopes: [] },
      { updateThrows: true },
    );
    const guard = new ServiceAccountGuard(prisma as never);
    await expect(
      guard.canActivate(makeCtx({ authorization: `Bearer ${PLAIN_TOKEN}` })),
    ).resolves.toBe(true);
    await new Promise((r) => setImmediate(r));
    // Просто не было throw, всё ок.
  });

  it('не-ks_sa_ префикс (похоже на JWT) → false, JWT-цепочке', async () => {
    const prisma = makePrisma(null);
    const guard = new ServiceAccountGuard(prisma as never);
    const ok = await guard.canActivate(
      makeCtx({ authorization: 'Bearer eyJhbGc.eyJzdWIuLi4.sig' }),
    );
    expect(ok).toBe(false);
    expect(prisma.agentServiceAccount.findFirst).not.toHaveBeenCalled();
  });

  it('без заголовка → false, JWT-цепочке', async () => {
    const prisma = makePrisma(null);
    const guard = new ServiceAccountGuard(prisma as never);
    const ok = await guard.canActivate(makeCtx({}));
    expect(ok).toBe(false);
    expect(prisma.agentServiceAccount.findFirst).not.toHaveBeenCalled();
  });

  it('ks_sa_-токен с префиксом, но запись не найдена → 401', async () => {
    const prisma = makePrisma(null);
    const guard = new ServiceAccountGuard(prisma as never);
    await expect(
      guard.canActivate(makeCtx({ authorization: `Bearer ${PLAIN_TOKEN}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokedAt не null → findFirst возвращает null (где где revokedAt: null) → 401', async () => {
    // Семантически это «отозванный токен»: where {revokedAt: null}
    // отсеит, и findFirst вернёт null → 401.
    const prisma = makePrisma(null);
    const guard = new ServiceAccountGuard(prisma as never);
    await expect(
      guard.canActivate(makeCtx({ authorization: `Bearer ${PLAIN_TOKEN}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('not-Bearer схема → false', async () => {
    const prisma = makePrisma(null);
    const guard = new ServiceAccountGuard(prisma as never);
    const ok = await guard.canActivate(
      makeCtx({ authorization: 'Basic abc123' }),
    );
    expect(ok).toBe(false);
  });
});
