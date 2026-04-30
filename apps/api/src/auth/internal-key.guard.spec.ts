/**
 * KS-2182. Тесты `InternalKeyGuard`.
 *
 * Покрывает GWT-сценарий 6 ("guard отвергает без секрета") + дополнительные
 * проверки, что guard не пропускает trafic с неправильным секретом и не
 * падает в ошибку конфигурации silent'ом.
 */
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalKeyGuard } from './internal-key.guard';

function makeCtx(headers: Record<string, string | undefined>): ExecutionContext {
  const req = {
    headers,
    method: 'POST',
    originalUrl: '/api/internal/auth/synthetic-token',
    ip: '10.0.0.5',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeConfig(value: string | undefined): ConfigService {
  return {
    get: (key: string) =>
      key === 'SYNTHETIC_BOT_INTERNAL_KEY' ? value : undefined,
  } as unknown as ConfigService;
}

describe('InternalKeyGuard — KS-2182', () => {
  it('ENV не задан → UnauthorizedException (конфиг-ошибка api-инстанса)', () => {
    const guard = new InternalKeyGuard(makeConfig(undefined));
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-auth': 'secret123' })),
    ).toThrow(UnauthorizedException);
  });

  it('ENV пуст → UnauthorizedException', () => {
    const guard = new InternalKeyGuard(makeConfig(''));
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-auth': 'secret123' })),
    ).toThrow(UnauthorizedException);
  });

  it('GWT-сценарий 6: запрос без X-Internal-Auth → UnauthorizedException', () => {
    const guard = new InternalKeyGuard(makeConfig('secret123'));
    expect(() => guard.canActivate(makeCtx({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('Заголовок присутствует, но не совпадает → ForbiddenException', () => {
    const guard = new InternalKeyGuard(makeConfig('secret123'));
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-auth': 'wrong-secret' })),
    ).toThrow(ForbiddenException);
  });

  it('Заголовок совпадает → allow', () => {
    const guard = new InternalKeyGuard(makeConfig('secret123'));
    expect(
      guard.canActivate(makeCtx({ 'x-internal-auth': 'secret123' })),
    ).toBe(true);
  });

  it('Заголовок отличается длиной → ForbiddenException (защита от timingSafeEqual mismatch)', () => {
    const guard = new InternalKeyGuard(makeConfig('secret123'));
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-auth': 'short' })),
    ).toThrow(ForbiddenException);
  });

  it('Заголовок передан как массив (нестандартно, но валидно для express) → используется первый элемент', () => {
    const guard = new InternalKeyGuard(makeConfig('secret123'));
    const req = {
      headers: { 'x-internal-auth': ['secret123', 'extra'] as any },
      method: 'POST',
      originalUrl: '/api/internal/auth/synthetic-token',
      ip: '10.0.0.5',
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
