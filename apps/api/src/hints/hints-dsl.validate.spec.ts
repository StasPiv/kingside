/**
 * KS-4702: validateRule — статическая валидация DSL без обращения к БД.
 * Бросает Error с понятным message → mapping на 400 в админ-CRUD.
 */
import { validateRule } from './hints-dsl.evaluator';

describe('validateRule', () => {
  it('валидное правило → no throw', () => {
    expect(() => validateRule({
      all: [
        { actorType: { equals: 'guest' } },
        { page: { matches: '/' } },
        { count: { event: 'guest_landing_viewed', windowMin: 5, gte: 1 } },
        { not: { exists: { event: 'guest_signup_form_opened', windowDays: 1 } } },
        { timeSince: { event: 'puzzle_start', gtDays: 7 } },
      ],
    })).not.toThrow();
  });

  it('не-объект → throw', () => {
    expect(() => validateRule(null)).toThrow(/объектом-DSL/);
    expect(() => validateRule(123 as never)).toThrow(/объектом-DSL/);
    expect(() => validateRule([] as never)).toThrow(/объектом-DSL/);
  });

  it('пустое правило → throw', () => {
    expect(() => validateRule({})).toThrow(/не содержит операторов/);
  });

  it('неизвестный оператор → throw с перечислением', () => {
    expect(() => validateRule({ bogus: {} } as never))
      .toThrow(/неизвестный оператор/);
  });

  it('page без matches → throw', () => {
    expect(() => validateRule({ page: {} })).toThrow(/page\.matches/);
  });

  it('actorType.equals не из {user,guest} → throw', () => {
    expect(() => validateRule({ actorType: { equals: 'admin' } } as never))
      .toThrow(/'user' или 'guest'/);
  });

  it('count без event → throw', () => {
    expect(() => validateRule({ count: { windowMin: 5, gte: 1 } } as never))
      .toThrow(/event/);
  });

  it('count без окна → throw', () => {
    expect(() => validateRule({ count: { event: 'x', gte: 1 } } as never))
      .toThrow(/окно/);
  });

  it('count без сравнения → throw', () => {
    expect(() => validateRule({ count: { event: 'x', windowMin: 5 } } as never))
      .toThrow(/сравнение/);
  });

  it('exists без окна → throw', () => {
    expect(() => validateRule({ exists: { event: 'x' } } as never))
      .toThrow(/окно/);
  });

  it('timeSince без gtMin/gtHours/gtDays → throw', () => {
    expect(() => validateRule({ timeSince: { event: 'x' } } as never))
      .toThrow(/gtMin/);
  });

  it('all/any/not — рекурсивная валидация', () => {
    expect(() => validateRule({
      all: [{ bogus: {} } as never],
    })).toThrow(/\$\.all\[0\]\.bogus/);
    expect(() => validateRule({
      any: [{ page: {} }],
    })).toThrow(/\$\.any\[0\]\.page\.matches/);
    expect(() => validateRule({
      not: { count: { event: 'x' } } as never,
    })).toThrow(/\$\.not\.count/);
  });
});
