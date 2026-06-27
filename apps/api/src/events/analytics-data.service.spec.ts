/**
 * KS-4697: AnalyticsDataService — delete/export/merge.
 * Mock'аем `EventsPrismaService` (вернёт null owner или fake actorEvent
 * с методами) и `RedisService`. Smoke-проверки на форму вызовов и на
 * идемпотентность.
 */
import { AnalyticsDataService } from './analytics-data.service';
import { AGG_KEY_PREFIX } from './events.types';

function makePrismaSvc(owner: any) {
  return { getOwner: () => owner, getWriter: () => owner } as any;
}

function makeRedis(over: Partial<any> = {}): any {
  return {
    scan: jest.fn().mockResolvedValue(['0', []]),
    del: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue(null),
    ttl: jest.fn().mockResolvedValue(-1),
    incrby: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    ...over,
  };
}

describe('AnalyticsDataService.deleteActorData', () => {
  it('owner=null → eventsDeleted=0, no throw', async () => {
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(null));
    const r = await svc.deleteActorData({ type: 'user', id: 'u1' });
    expect(r).toEqual({ eventsDeleted: 0, aggKeysDeleted: 0 });
  });

  it('owner есть → вызывает deleteMany с правильным where', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 7 });
    const owner = { actorEvent: { deleteMany } };
    const redis = makeRedis({
      scan: jest.fn()
        .mockResolvedValueOnce(['0', [`${AGG_KEY_PREFIX}u1:page_view:1m`]]),
      del: jest.fn().mockResolvedValue(1),
    });
    const svc = new AnalyticsDataService(redis, makePrismaSvc(owner));
    const r = await svc.deleteActorData({ type: 'user', id: 'u1' });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { actorId: 'u1', actorType: 'user' },
    });
    expect(r.eventsDeleted).toBe(7);
    expect(r.aggKeysDeleted).toBe(1);
  });

  it('idempotent: повторный delete возвращает 0 без падения', async () => {
    const deleteMany = jest.fn()
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 0 });
    const owner = { actorEvent: { deleteMany } };
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    await svc.deleteActorData({ type: 'user', id: 'u1' });
    const r2 = await svc.deleteActorData({ type: 'user', id: 'u1' });
    expect(r2.eventsDeleted).toBe(0);
  });
});

describe('AnalyticsDataService.mergeGuestToUser', () => {
  it('owner=null → no throw, eventsMigrated=0', async () => {
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(null));
    const r = await svc.mergeGuestToUser({ guestId: 'g', userId: 'u' });
    expect(r).toEqual({ eventsMigrated: 0, aggKeysMigrated: 0 });
  });

  it('owner есть → UPDATE actor_id+actor_type в транзакции', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 5 });
    const owner = {
      actorEvent: { updateMany },
      $transaction: jest.fn(async (cb: any) => cb({ actorEvent: { updateMany } })),
    };
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.mergeGuestToUser({ guestId: 'g', userId: 'u' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { actorId: 'g', actorType: 'guest' },
      data: { actorId: 'u', actorType: 'user' },
    });
    expect(r.eventsMigrated).toBe(5);
  });

  it('повторный merge без guest-данных → 0 строк, no-op', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const owner = {
      actorEvent: { updateMany },
      $transaction: jest.fn(async (cb: any) => cb({ actorEvent: { updateMany } })),
    };
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.mergeGuestToUser({ guestId: 'g', userId: 'u' });
    expect(r.eventsMigrated).toBe(0);
  });

  it('Redis agg-ключи: COPY + DEL по SCAN', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const owner = {
      actorEvent: { updateMany },
      $transaction: jest.fn(async (cb: any) => cb({ actorEvent: { updateMany } })),
    };
    const redis = makeRedis({
      scan: jest.fn()
        .mockResolvedValueOnce(['0', [`${AGG_KEY_PREFIX}g:page_view:1m`]]),
      get: jest.fn().mockResolvedValue('5'),
      ttl: jest.fn().mockResolvedValue(45),
      incrby: jest.fn().mockResolvedValue(5),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    });
    const svc = new AnalyticsDataService(redis, makePrismaSvc(owner));
    const r = await svc.mergeGuestToUser({ guestId: 'g', userId: 'u' });
    expect(redis.incrby).toHaveBeenCalledWith(`${AGG_KEY_PREFIX}u:page_view:1m`, 5);
    expect(redis.expire).toHaveBeenCalledWith(`${AGG_KEY_PREFIX}u:page_view:1m`, 45);
    expect(redis.del).toHaveBeenCalledWith(`${AGG_KEY_PREFIX}g:page_view:1m`);
    expect(r.aggKeysMigrated).toBe(1);
  });
});

describe('AnalyticsDataService.streamExport', () => {
  it('структура JSON: actor + actor_events + actor_hint_states', async () => {
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const owner = { actorEvent: { findMany } };
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    let combined = '';
    for await (const chunk of svc.streamExport({ type: 'user', id: 'u1' }, '2026-06-27T00:00:00Z')) {
      combined += chunk;
    }
    const parsed = JSON.parse(combined);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.exported_at).toBe('2026-06-27T00:00:00Z');
    expect(parsed.actor).toEqual({ type: 'user', id: 'u1' });
    expect(parsed.actor_events).toEqual([]);
    expect(parsed.actor_hint_states).toEqual([]);
  });

  it('пейджинит по cursor `id` и сериализует BigInt в строку', async () => {
    const page1 = [{ id: BigInt(1), type: 'a', payload: { x: 1 }, createdAt: new Date('2026-06-01') }];
    const findMany = jest.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([]);
    const owner = { actorEvent: { findMany } };
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    let combined = '';
    for await (const chunk of svc.streamExport({ type: 'guest', id: 'g' }, '2026-06-27T00:00:00Z')) {
      combined += chunk;
    }
    const parsed = JSON.parse(combined);
    expect(parsed.actor_events[0]).toEqual({
      id: '1',
      type: 'a',
      payload: { x: 1 },
      created_at: '2026-06-01T00:00:00.000Z',
    });
  });
});
