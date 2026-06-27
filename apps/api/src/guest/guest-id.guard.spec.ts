/**
 * KS-4697: GuestIdGuard — три ветки:
 *   - JWT-юзер (Bearer) → 401 (используй /me/*).
 *   - Нет guestId → 401 (нужен consent).
 *   - guestId выставлен middleware → проходит.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GuestIdGuard } from './guest-id.guard';

function makeCtx(headers: Record<string, string>, guestId?: string | null): ExecutionContext {
  const req = { headers, guestId };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('GuestIdGuard', () => {
  const guard = new GuestIdGuard();

  it('Bearer токен → UnauthorizedException', () => {
    expect(() => guard.canActivate(makeCtx({ authorization: 'Bearer xyz' })))
      .toThrow(UnauthorizedException);
  });

  it('Нет guestId → UnauthorizedException', () => {
    expect(() => guard.canActivate(makeCtx({}))).toThrow(UnauthorizedException);
  });

  it('Есть guestId, нет Bearer → true', () => {
    expect(guard.canActivate(makeCtx({}, 'g-1'))).toBe(true);
  });
});
