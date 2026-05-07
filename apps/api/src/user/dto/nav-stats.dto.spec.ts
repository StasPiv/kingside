import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NAV_ROUTES, NavStatsIncrementDto } from './nav-stats.dto';

/**
 * KS-2537 / ADR-048 §3 #1. Whitelist nav-routes для
 * `/user/nav-stats/increment`. Любой неизвестный route → constraint
 * failure → ValidationPipe возвращает HTTP 400.
 */

describe('NavStatsIncrementDto', () => {
  it('NAV_ROUTES содержит "precision" (KS-2537)', () => {
    expect(NAV_ROUTES).toContain('precision');
  });

  it('сохранены все исторические route (regression)', () => {
    // Если фронт удалил route — pin'им backward-compat.
    expect(NAV_ROUTES).toEqual(
      expect.arrayContaining([
        'play',
        'tournaments',
        'workshop',
        'lessons',
        'drills',
        'broadcasts',
        'archive',
        'profile',
        'puzzles',
        'precision',
      ]),
    );
  });

  it('valid: precision проходит whitelist', async () => {
    const dto = plainToInstance(NavStatsIncrementDto, { route: 'precision' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('valid: каждый из NAV_ROUTES проходит whitelist', async () => {
    for (const route of NAV_ROUTES) {
      const dto = plainToInstance(NavStatsIncrementDto, { route });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('invalid: неизвестный route → constraint failure', async () => {
    const dto = plainToInstance(NavStatsIncrementDto, { route: 'unknown' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('route');
    expect(errors[0].constraints).toMatchObject({ isIn: expect.any(String) });
  });

  it('invalid: пустая строка → constraint failure', async () => {
    const dto = plainToInstance(NavStatsIncrementDto, { route: '' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('route');
  });

  it('invalid: route не передан → constraint failure', async () => {
    const dto = plainToInstance(NavStatsIncrementDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('route');
  });
});
