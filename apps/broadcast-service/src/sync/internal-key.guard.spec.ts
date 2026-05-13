/**
 * KS-2883 / ADR-060 §3.7 B10. Тесты InternalKeyGuard broadcast-service.
 *
 * Покрытие:
 *  - ENV не задан → 401 UnauthorizedException;
 *  - заголовок отсутствует → 401;
 *  - заголовок неверный → 403;
 *  - заголовок другой длины → 403 (защита timingSafeEqual);
 *  - правильный заголовок → allow.
 */
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_AUTH_HEADER } from '@kingside/shared';
import { InternalKeyGuard } from './internal-key.guard';

function ctxWithHeader(value: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { [INTERNAL_AUTH_HEADER.toLowerCase()]: value },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('InternalKeyGuard (KS-2883)', () => {
  it('ENV не задан → 401', () => {
    const g = new InternalKeyGuard(
      makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: '' }),
    );
    expect(() => g.canActivate(ctxWithHeader('xxx'))).toThrow(
      UnauthorizedException,
    );
  });

  it('заголовок отсутствует → 401', () => {
    const g = new InternalKeyGuard(
      makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: 'sekret' }),
    );
    expect(() => g.canActivate(ctxWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('заголовок неверный → 403', () => {
    const g = new InternalKeyGuard(
      makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: 'sekret' }),
    );
    expect(() => g.canActivate(ctxWithHeader('wrong-'))).toThrow(
      ForbiddenException,
    );
  });

  it('заголовок другой длины → 403 (timingSafeEqual защита)', () => {
    const g = new InternalKeyGuard(
      makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: 'longerkey' }),
    );
    expect(() => g.canActivate(ctxWithHeader('short'))).toThrow(
      ForbiddenException,
    );
  });

  it('правильный заголовок → allow', () => {
    const g = new InternalKeyGuard(
      makeConfig({ SYNTHETIC_BOT_INTERNAL_KEY: 'sekret' }),
    );
    expect(g.canActivate(ctxWithHeader('sekret'))).toBe(true);
  });
});
