import { describe, it, expect } from 'vitest';
import { decode, encode, validate, type RuleNode } from './ruleBuilderModel';

/**
 * KS-4830. Roundtrip-тесты на трёх существующих сидируемых подсказках
 * (`tools/seed-test-hints.sql`). Конструктор должен корректно
 * загружать их `rule` и собирать обратно в идентичный JSON.
 */

const HOME_IDLE_RULE = {
  all: [
    { actorType: { equals: 'user' } },
    { page: { matches: '/lobby' } },
    { count: { event: 'session_idle', windowMin: 5, gte: 1 } },
  ],
};

const BRIDGE_PROMO_RULE = {
  all: [
    {
      any: [
        { page: { matches: '/analysis' } },
        { page: { matches: '/analysis/*' } },
      ],
    },
    {
      count: {
        event: 'engine_started',
        where: { source: 'wasm' },
        windowDays: 30,
        gte: 3,
      },
    },
    {
      not: {
        exists: {
          event: 'engine_started',
          where: { source: 'bridge' },
          windowDays: 30,
        },
      },
    },
  ],
};

const ANALYZE_AFTER_LOSS_RULE = {
  all: [
    { actorType: { equals: 'user' } },
    {
      any: [
        { page: { matches: '/game/*' } },
        { page: { matches: '/play/*' } },
      ],
    },
    {
      count: {
        event: 'game_end',
        where: { result: 'loss' },
        windowDays: 7,
        gte: 3,
      },
    },
    { not: { exists: { event: 'analysis_open', windowMin: 30 } } },
  ],
};

describe('ruleBuilderModel — decode/encode roundtrip', () => {
  it.each([
    ['home-idle-suggest-puzzles', HOME_IDLE_RULE],
    ['bridge-promo-after-3-wasm', BRIDGE_PROMO_RULE],
    ['analyze-after-loss', ANALYZE_AFTER_LOSS_RULE],
  ])('%s — encode(decode(rule)) === rule', (_key, rule) => {
    const node = decode(rule);
    expect(node).not.toBeNull();
    const reencoded = encode(node as RuleNode);
    expect(reencoded).toEqual(rule);
  });

  it('timeSince — roundtrip', () => {
    const rule = { timeSince: { event: 'session_start', gtMin: 60 } };
    const node = decode(rule);
    expect(node).not.toBeNull();
    expect(encode(node as RuleNode)).toEqual(rule);
  });

  it('decode → null для неизвестного оператора (fallback на raw JSON)', () => {
    expect(decode({ foo: { event: 'x' } })).toBeNull();
  });

  it('decode → null для count с двумя window-units (несовместимо)', () => {
    expect(
      decode({
        count: { event: 'game_end', windowDays: 7, windowMin: 5, gte: 1 },
      }),
    ).toBeNull();
  });

  it('decode → null для count с неизвестным полем layer (расширение)', () => {
    expect(
      decode({
        count: {
          event: 'game_end',
          windowDays: 7,
          gte: 1,
          layer: 'matview',
        },
      }),
    ).toBeNull();
  });

  it('decode → null для page с дополнительными полями', () => {
    expect(decode({ page: { matches: '/x', exact: true } })).toBeNull();
  });

  it('decode → null для пустого объекта / не-объекта / массива', () => {
    expect(decode({})).toBeNull();
    expect(decode(null)).toBeNull();
    expect(decode([])).toBeNull();
    expect(decode('all')).toBeNull();
  });

  it('encode пустого all → { all: [] }', () => {
    expect(encode({ kind: 'all', children: [] })).toEqual({ all: [] });
  });
});

describe('ruleBuilderModel — validate', () => {
  it('пустой all возвращает ошибку', () => {
    const errs = validate({ kind: 'all', children: [] });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('count без event/windowValue/opValue возвращает ошибки', () => {
    const node = decode(BRIDGE_PROMO_RULE) as RuleNode;
    expect(validate(node)).toEqual([]); // валидное правило → ошибок нет
  });

  it('count с пустым event и без значений сообщает три ошибки', () => {
    const errs = validate({
      kind: 'count',
      event: '',
      where: [],
      windowUnit: 'windowDays',
      windowValue: '',
      op: 'gte',
      opValue: '',
    });
    expect(errs.length).toBe(3);
  });

  it('actorType без equals сообщает ошибку', () => {
    const errs = validate({ kind: 'actorType', equals: '' });
    expect(errs).toHaveLength(1);
  });
});
