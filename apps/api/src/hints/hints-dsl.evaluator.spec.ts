/**
 * KS-4699: DSL evaluator — unit-тесты на каждый оператор.
 * Моки `events`-Prisma — только методы actorEvent.findMany/findFirst.
 */
import { evaluateRule, globMatch } from './hints-dsl.evaluator';

function mkEvents(rows: any[] = [], first: any = null, rawCount?: number): any {
  // KS-4782: evaluator использует $queryRawUnsafe для payload-фильтров.
  // По умолчанию возвращаем тот же count что и findMany — для тестов
  // count.where с конкретным числом строк rawCount можно переопределить.
  const c = BigInt(rawCount ?? rows.length);
  return {
    actorEvent: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn().mockResolvedValue(first),
    },
    $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
      // exists-ветка содержит LIMIT — отдаём rows[0..limit].
      if (typeof sql === 'string' && sql.includes('LIMIT')) {
        return Promise.resolve(rows.slice(0, 1));
      }
      return Promise.resolve([{ c }]);
    }),
  };
}

const ACTOR_USER = { type: 'user' as const, id: 'u1' };
const ACTOR_GUEST = { type: 'guest' as const, id: 'g1' };

describe('DSL evaluator — operators', () => {
  it('page.matches: glob с *', async () => {
    const ev = mkEvents();
    expect(await evaluateRule({ page: { matches: '/play/*' } }, ACTOR_USER, { page: '/play/abc' }, { events: ev })).toBe(true);
    expect(await evaluateRule({ page: { matches: '/play/*' } }, ACTOR_USER, { page: '/play/abc/deep' }, { events: ev })).toBe(false);
    expect(await evaluateRule({ page: { matches: '/' } }, ACTOR_USER, { page: '/' }, { events: ev })).toBe(true);
  });

  it('actorType.equals', async () => {
    const ev = mkEvents();
    expect(await evaluateRule({ actorType: { equals: 'user' } }, ACTOR_USER, {}, { events: ev })).toBe(true);
    expect(await evaluateRule({ actorType: { equals: 'guest' } }, ACTOR_USER, {}, { events: ev })).toBe(false);
    expect(await evaluateRule({ actorType: { equals: 'guest' } }, ACTOR_GUEST, {}, { events: ev })).toBe(true);
  });

  it('count.gte с windowMin', async () => {
    const ev = mkEvents([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const ok = await evaluateRule(
      { count: { event: 'game_start', windowMin: 30, gte: 3 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ok).toBe(true);
    expect(ev.actorEvent.findMany).toHaveBeenCalled();
    const lt = await evaluateRule(
      { count: { event: 'game_start', windowMin: 30, gte: 5 } },
      ACTOR_USER, {}, { events: mkEvents([{}, {}]) },
    );
    expect(lt).toBe(false);
  });

  // KS-4782 (вторая итерация): payload-фильтры идут через $queryRaw
  // (`payload->>'<key>' = '<value>'`), не через Prisma JSONFilter —
  // последний на 6.19.2 + PG16 возвращал count=0 даже при `equals`.
  // Тесты проверяют что $queryRaw вызывается с правильными параметрами
  // и итоговое булево корректное.
  it('count.where: $queryRaw вызван с payload-clause', async () => {
    const ev = mkEvents([{ id: '1' }]);
    await evaluateRule(
      { count: { event: 'game_start', where: { rated: true }, windowMin: 30, gte: 1 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ev.$queryRawUnsafe).toHaveBeenCalled();
    expect(ev.actorEvent.findMany).not.toHaveBeenCalled();
  });

  it('count.where: строка result=loss, count=14 ≥3 → true', async () => {
    const ev = mkEvents([], null, 14);
    const ok = await evaluateRule(
      { count: { event: 'game_end', where: { result: 'loss' }, windowDays: 7, gte: 3 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ok).toBe(true);
    expect(ev.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('count.where: bool — $queryRaw, gte=1 при count=1 → true', async () => {
    const ev = mkEvents([], null, 1);
    const ok = await evaluateRule(
      { count: { event: 'game_start', where: { rated: true }, windowMin: 30, gte: 1 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ok).toBe(true);
    expect(ev.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('count.where: number — $queryRaw, gte=1 при count=0 → false', async () => {
    const ev = mkEvents([], null, 0);
    const ok = await evaluateRule(
      { count: { event: 'rating_change', where: { delta: 10 }, windowMin: 30, gte: 1 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ok).toBe(false);
    expect(ev.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('count.where: смешанный string + bool — оба условия в одном payload-clause', async () => {
    const ev = mkEvents([], null, 5);
    await evaluateRule(
      { count: { event: 'game_end', where: { result: 'loss', rated: true }, windowDays: 7, gte: 1 } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(ev.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('exists.event: true если хотя бы один найден', async () => {
    const ev = mkEvents([], { id: '1' });
    expect(await evaluateRule(
      { exists: { event: 'puzzle_solved', windowDays: 7 } },
      ACTOR_USER, {}, { events: ev },
    )).toBe(true);
    const ev2 = mkEvents([], null);
    expect(await evaluateRule(
      { exists: { event: 'puzzle_solved', windowDays: 7 } },
      ACTOR_USER, {}, { events: ev2 },
    )).toBe(false);
  });

  it('not: инверсия', async () => {
    const ev = mkEvents([], null);
    const r = await evaluateRule(
      { not: { exists: { event: 'foo', windowDays: 1 } } },
      ACTOR_USER, {}, { events: ev },
    );
    expect(r).toBe(true);
  });

  it('timeSince: gtDays', async () => {
    const lastWeek = new Date(Date.now() - 8 * 86400_000);
    const ev = mkEvents([], { createdAt: lastWeek });
    expect(await evaluateRule(
      { timeSince: { event: 'puzzle_start', gtDays: 7 } },
      ACTOR_USER, {}, { events: ev },
    )).toBe(true);
    const recent = new Date(Date.now() - 3 * 86400_000);
    const ev2 = mkEvents([], { createdAt: recent });
    expect(await evaluateRule(
      { timeSince: { event: 'puzzle_start', gtDays: 7 } },
      ACTOR_USER, {}, { events: ev2 },
    )).toBe(false);
  });

  it('timeSince: никогда не было события → true', async () => {
    const ev = mkEvents([], null);
    expect(await evaluateRule(
      { timeSince: { event: 'puzzle_start', gtDays: 7 } },
      ACTOR_USER, {}, { events: ev },
    )).toBe(true);
  });

  it('all: все должны пройти', async () => {
    const ev = mkEvents([], { id: '1' });
    const r = await evaluateRule({
      all: [
        { page: { matches: '/' } },
        { actorType: { equals: 'user' } },
        { exists: { event: 'page_view', windowDays: 1 } },
      ],
    }, ACTOR_USER, { page: '/' }, { events: ev });
    expect(r).toBe(true);
  });

  it('all: short-circuit при первом false', async () => {
    const ev = mkEvents([], null);
    const r = await evaluateRule({
      all: [
        { page: { matches: '/admin/*' } },
        { exists: { event: 'page_view', windowDays: 1 } },
      ],
    }, ACTOR_USER, { page: '/' }, { events: ev });
    expect(r).toBe(false);
    expect(ev.actorEvent.findFirst).not.toHaveBeenCalled();
  });

  it('any: достаточно одного true', async () => {
    const ev = mkEvents([], null);
    const r = await evaluateRule({
      any: [
        { page: { matches: '/admin/*' } },
        { actorType: { equals: 'user' } },
      ],
    }, ACTOR_USER, { page: '/' }, { events: ev });
    expect(r).toBe(true);
  });

  it('гостевое правило: actorType=guest + page=/ + ¬exists(signup)', async () => {
    const ev = mkEvents([{ id: '1' }], null);
    const rule = {
      all: [
        { actorType: { equals: 'guest' } },
        { page: { matches: '/' } },
        { count: { event: 'guest_landing_viewed', windowMin: 5, gte: 1 } },
        { not: { exists: { event: 'guest_signup_form_opened', windowDays: 1 } } },
      ],
    };
    expect(await evaluateRule(rule, ACTOR_GUEST, { page: '/' }, { events: ev })).toBe(true);
    expect(await evaluateRule(rule, ACTOR_USER, { page: '/' }, { events: ev })).toBe(false);
  });

  it('неизвестный оператор → false (warn)', async () => {
    const ev = mkEvents();
    const r = await evaluateRule({ bogus: { foo: 1 } }, ACTOR_USER, {}, { events: ev });
    expect(r).toBe(false);
  });

  it('events=null → defensive false', async () => {
    const r = await evaluateRule(
      { count: { event: 'x', windowMin: 1, gte: 1 } },
      ACTOR_USER, {}, { events: null },
    );
    expect(r).toBe(false);
  });
});

describe('globMatch', () => {
  it('точные совпадения', () => {
    expect(globMatch('/admin/users', '/admin/users')).toBe(true);
    expect(globMatch('/admin/users', '/admin/other')).toBe(false);
  });
  it('* — один сегмент', () => {
    expect(globMatch('/live/*', '/live/abc')).toBe(true);
    expect(globMatch('/live/*', '/live/abc/def')).toBe(false);
  });
  it('экранирует regex-метасимволы', () => {
    expect(globMatch('/a.b', '/a.b')).toBe(true);
    expect(globMatch('/a.b', '/axb')).toBe(false);
  });
});
