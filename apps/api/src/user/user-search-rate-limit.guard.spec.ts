/**
 * KS-3938 / ADR-118 §2.4.1. Unit-тесты per-user rate-limit'а для
 * `GET /users/search`.
 */
import { HttpException } from '@nestjs/common';
import { UserSearchRateLimitGuard } from './user-search-rate-limit.guard';

function makeCtx(userId: string | null) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: userId ? { id: userId } : undefined,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }),
    }),
  } as never;
}

describe('UserSearchRateLimitGuard', () => {
  let guard: UserSearchRateLimitGuard;

  beforeEach(() => {
    guard = new UserSearchRateLimitGuard();
  });

  it('первый запрос пропускает', () => {
    expect(guard.canActivate(makeCtx('user-1'))).toBe(true);
  });

  it('30 запросов в окне проходят, 31-й — 429', () => {
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(makeCtx('user-1'))).toBe(true);
    }
    expect(() => guard.canActivate(makeCtx('user-1'))).toThrow(HttpException);
  });

  it('счётчик у разных пользователей раздельный', () => {
    for (let i = 0; i < 30; i++) guard.canActivate(makeCtx('user-1'));
    expect(() => guard.canActivate(makeCtx('user-1'))).toThrow(HttpException);
    // user-2 ещё ни разу — должен пройти.
    expect(guard.canActivate(makeCtx('user-2'))).toBe(true);
  });

  it('сброс счётчика после истечения окна', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-08T12:00:00Z'));
    for (let i = 0; i < 30; i++) guard.canActivate(makeCtx('user-1'));
    expect(() => guard.canActivate(makeCtx('user-1'))).toThrow(HttpException);
    // +61с — окно закрылось.
    jest.setSystemTime(new Date('2026-06-08T12:01:01Z'));
    expect(guard.canActivate(makeCtx('user-1'))).toBe(true);
    jest.useRealTimers();
  });

  it('anon (нет req.user) → используется IP как ключ', () => {
    // anon должен подчиняться тому же лимиту, ключ — IP.
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(makeCtx(null))).toBe(true);
    }
    expect(() => guard.canActivate(makeCtx(null))).toThrow(HttpException);
  });
});
