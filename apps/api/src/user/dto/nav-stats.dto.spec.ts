import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  aggregateNavRoute,
  GROUP_NAV_ROUTES,
  LEGACY_NAV_ROUTES,
  NAV_ROUTES,
  NavStatsIncrementDto,
} from './nav-stats.dto';

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

  describe('KS-2809 / ADR-058 T12 — групповые ключи в whitelist', () => {
    it('NAV_ROUTES содержит и старые, и новые групповые ключи', () => {
      expect(NAV_ROUTES).toEqual(
        expect.arrayContaining([...LEGACY_NAV_ROUTES, ...GROUP_NAV_ROUTES]),
      );
    });

    it('puzzle-rush принимается (раньше в whitelist не был)', async () => {
      const dto = plainToInstance(NavStatsIncrementDto, {
        route: 'puzzle-rush',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it.each(['train', 'learn', 'analyze'])(
      'групповой ключ %s принимается (PostV2)',
      async (route) => {
        const dto = plainToInstance(NavStatsIncrementDto, { route });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      },
    );

    it.each(['puzzles', 'drills', 'precision', 'workshop', 'archive'])(
      'legacy ключ %s продолжает приниматься (PostV1 регрессия)',
      async (route) => {
        const dto = plainToInstance(NavStatsIncrementDto, { route });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      },
    );
  });

  describe('aggregateNavRoute — KS-2809', () => {
    it.each([
      ['puzzles', 'train'],
      ['drills', 'train'],
      ['precision', 'train'],
      ['puzzle-rush', 'train'],
      ['train', 'train'],
      ['workshop', 'analyze'],
      ['archive', 'analyze'],
      ['analyze', 'analyze'],
      ['tournaments', 'play'],
      ['play', 'play'],
      ['lessons', 'learn'],
      ['learn', 'learn'],
      ['broadcasts', 'broadcasts'],
      ['profile', 'profile'],
    ])('маппинг %s → %s', (input, expected) => {
      expect(aggregateNavRoute(input)).toBe(expected);
    });

    it('неизвестный route → null', () => {
      expect(aggregateNavRoute('unknown')).toBeNull();
      expect(aggregateNavRoute('')).toBeNull();
    });
  });
});
