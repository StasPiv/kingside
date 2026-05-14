/**
 * KS-3029. Тесты `DevOnlyGuard`.
 *
 * Покрытие:
 *  - prod (NODE_ENV='production') → 404.
 *  - dev / staging / undefined → allow.
 *  - ConfigService приоритет над process.env (контролируемый источник).
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DevOnlyGuard } from './dev-only.guard';

function makeConfig(value: string | undefined): ConfigService {
  return {
    get: (key: string) =>
      key === 'NODE_ENV' ? value : undefined,
  } as unknown as ConfigService;
}

const ctx = {
  switchToHttp: () => ({ getRequest: () => ({}) }),
} as unknown as ExecutionContext;

describe('DevOnlyGuard — KS-3029', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('NODE_ENV=production → NotFoundException (404)', () => {
    const guard = new DevOnlyGuard(makeConfig('production'));
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('NODE_ENV=development → allow', () => {
    const guard = new DevOnlyGuard(makeConfig('development'));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('NODE_ENV=staging → allow', () => {
    const guard = new DevOnlyGuard(makeConfig('staging'));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('NODE_ENV=test → allow', () => {
    const guard = new DevOnlyGuard(makeConfig('test'));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('NODE_ENV не задан в ConfigService — fallback на process.env', () => {
    process.env.NODE_ENV = 'production';
    const guard = new DevOnlyGuard(makeConfig(undefined));
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('NODE_ENV не задан нигде → allow (dev по умолчанию)', () => {
    delete process.env.NODE_ENV;
    const guard = new DevOnlyGuard(makeConfig(undefined));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('ConfigService=development перебивает process.env=production', () => {
    process.env.NODE_ENV = 'production';
    const guard = new DevOnlyGuard(makeConfig('development'));
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
