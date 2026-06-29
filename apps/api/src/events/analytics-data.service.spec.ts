/**
 * KS-4697: AnalyticsDataService — delete/export/merge.
 * Mock'аем `EventsPrismaService` (вернёт null owner или fake actorEvent
 * с методами) и `RedisService`. Smoke-проверки на форму вызовов и на
 * идемпотентность.
 */
import {
  AnalyticsDataService,
  buildTypeFilter,
  decodeCursor,
  encodeCursor,
  EVENTS_RETENTION_DAYS,
} from './analytics-data.service';
import { AGG_KEY_PREFIX } from './events.types';
import { SYSTEM_EVENT_TYPES } from '@kingside/shared';

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
    expect(r).toEqual({ eventsDeleted: 0, aggKeysDeleted: 0, hintsKeysDeleted: 0 });
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

  it('hints runtime-ключи: SCAN+DEL для hints:session:* + DEL throttle/last-page/pending', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const owner = { actorEvent: { deleteMany }, actorHintState: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    let scanCallIdx = 0;
    const scan = jest.fn().mockImplementation((cursor, ...rest) => {
      // первый scan — agg:*, второй — hints:session:*
      scanCallIdx += 1;
      if (scanCallIdx === 1) return Promise.resolve(['0', []]);
      if (scanCallIdx === 2) {
        return Promise.resolve(['0', [`hints:session:u1:2026-06-29`, `hints:session:u1:2026-06-28`]]);
      }
      return Promise.resolve(['0', []]);
    });
    const del = jest.fn()
      // первый вызов — на пачку session-ключей (2)
      .mockResolvedValueOnce(2)
      // потом по одному для throttle/last-page/pending — все возвращают 1
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const redis = makeRedis({ scan, del });
    const svc = new AnalyticsDataService(redis, makePrismaSvc(owner));
    const r = await svc.deleteActorData({ type: 'user', id: 'u1' });
    expect(r.hintsKeysDeleted).toBe(5); // 2 session + throttle + last-page + pending
    expect(del).toHaveBeenCalledWith('hints:session:u1:2026-06-29', 'hints:session:u1:2026-06-28');
    expect(del).toHaveBeenCalledWith('hints:throttle:u1');
    expect(del).toHaveBeenCalledWith('hints:last-page:u1');
    expect(del).toHaveBeenCalledWith('hints:pending:u1');
  });

  it('hints runtime-ключи: ошибки одиночных DEL не блокируют остальные', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const owner = { actorEvent: { deleteMany }, actorHintState: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    let scanCallIdx = 0;
    const scan = jest.fn().mockImplementation(() => {
      scanCallIdx += 1;
      return Promise.resolve(['0', []]); // SCAN agg + SCAN hints:session — оба пустые
    });
    const del = jest.fn()
      .mockRejectedValueOnce(new Error('throttle del failed'))
      .mockResolvedValueOnce(1) // last-page OK
      .mockResolvedValueOnce(1); // pending OK
    const redis = makeRedis({ scan, del });
    const svc = new AnalyticsDataService(redis, makePrismaSvc(owner));
    const r = await svc.deleteActorData({ type: 'user', id: 'u1' });
    expect(r.hintsKeysDeleted).toBe(2); // throttle упал, остальные ок
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

describe('AnalyticsDataService.listEvents', () => {
  function makeOwner(rows: Array<{
    id: bigint; type: string; payload: unknown; createdAt: Date;
  }>) {
    const findMany = jest.fn().mockResolvedValue(rows);
    return { findMany, owner: { actorEvent: { findMany } } };
  }

  it('owner=null → empty result + retention_days=90', async () => {
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(null));
    const r = await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 50, showSystem: false },
    );
    expect(r).toEqual({
      items: [],
      next_cursor: null,
      has_more: false,
      retention_days: EVENTS_RETENTION_DAYS,
    });
  });

  it('передаёт фильтр actorId + actorType, ORDER BY createdAt DESC + id DESC, take=limit+1', async () => {
    const { findMany, owner } = makeOwner([]);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 50, showSystem: true },
    );
    const args = findMany.mock.calls[0][0];
    expect(args.where.actorId).toBe('u1');
    expect(args.where.actorType).toBe('user');
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(51);
  });

  it('showSystem=false без types → type.notIn = SYSTEM_EVENT_TYPES', async () => {
    const { findMany, owner } = makeOwner([]);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 10, showSystem: false },
    );
    expect(findMany.mock.calls[0][0].where.type).toEqual({ notIn: SYSTEM_EVENT_TYPES });
  });

  it('showSystem=true без types → нет фильтра по type', async () => {
    const { findMany, owner } = makeOwner([]);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 10, showSystem: true },
    );
    expect(findMany.mock.calls[0][0].where.type).toBeUndefined();
  });

  it('showSystem=false + types включает системный → системный отрезается', async () => {
    const { findMany, owner } = makeOwner([]);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 10, showSystem: false, types: ['game_end', 'page_view'] },
    );
    expect(findMany.mock.calls[0][0].where.type).toEqual({ in: ['game_end'] });
  });

  it('items.length <= limit, has_more=true когда строк больше', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: BigInt(100 - i),
      type: 'game_end',
      payload: { i },
      createdAt: new Date(`2026-06-${20 + i}T10:00:00Z`),
    }));
    const { owner } = makeOwner(rows);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 5, showSystem: true },
    );
    expect(r.items.length).toBe(5);
    expect(r.has_more).toBe(true);
    expect(r.next_cursor).not.toBeNull();
  });

  it('items < limit → has_more=false, next_cursor=null', async () => {
    const rows = [
      { id: BigInt(1), type: 'game_end', payload: {}, createdAt: new Date('2026-06-20T10:00:00Z') },
    ];
    const { owner } = makeOwner(rows);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 10, showSystem: true },
    );
    expect(r.items.length).toBe(1);
    expect(r.has_more).toBe(false);
    expect(r.next_cursor).toBeNull();
  });

  it('BigInt id → string, createdAt → ISO', async () => {
    const rows = [
      { id: BigInt('9876543210'), type: 'game_end', payload: { game_id: 'g1' }, createdAt: new Date('2026-06-20T10:00:00.123Z') },
    ];
    const { owner } = makeOwner(rows);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 10, showSystem: true },
    );
    expect(r.items[0]).toEqual({
      id: '9876543210',
      type: 'game_end',
      payload: { game_id: 'g1' },
      created_at: '2026-06-20T10:00:00.123Z',
    });
  });

  it('cursor → WHERE OR ветви по (createdAt, id)', async () => {
    const { findMany, owner } = makeOwner([]);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const cursorCreatedAt = new Date('2026-06-25T10:00:00Z');
    const cursorId = BigInt(42);
    await svc.listEvents(
      { type: 'user', id: 'u1' },
      {
        limit: 10,
        showSystem: true,
        cursor: { createdAt: cursorCreatedAt, id: cursorId },
      },
    );
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { createdAt: { lt: cursorCreatedAt } },
      { createdAt: cursorCreatedAt, id: { lt: cursorId } },
    ]);
  });

  it('next_cursor декодируется обратно в createdAt+id последней видимой записи', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: BigInt(100 - i),
      type: 'game_end',
      payload: {},
      createdAt: new Date(`2026-06-2${5 - i}T10:00:00Z`),
    }));
    const { owner } = makeOwner(rows);
    const svc = new AnalyticsDataService(makeRedis(), makePrismaSvc(owner));
    const r = await svc.listEvents(
      { type: 'user', id: 'u1' },
      { limit: 3, showSystem: true },
    );
    expect(r.has_more).toBe(true);
    const decoded = decodeCursor(r.next_cursor);
    expect(decoded?.id).toBe(BigInt(98));
    expect(decoded?.createdAt.toISOString()).toBe('2026-06-23T10:00:00.000Z');
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trip сохраняет createdAt + id', () => {
    const orig = { createdAt: new Date('2026-06-20T12:34:56.789Z'), id: BigInt('123456789012345') };
    const decoded = decodeCursor(encodeCursor(orig));
    expect(decoded?.createdAt.toISOString()).toBe(orig.createdAt.toISOString());
    expect(decoded?.id).toBe(orig.id);
  });

  it('пустой/undefined → null (нет ошибки)', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('мусор → throw', () => {
    expect(() => decodeCursor('not-base64-!!!')).toThrow(/cursor/);
    expect(() => decodeCursor(Buffer.from('not-json', 'utf8').toString('base64url'))).toThrow(/cursor/);
    expect(() => decodeCursor(Buffer.from('{"x":1}', 'utf8').toString('base64url'))).toThrow(/missing/);
    expect(() => decodeCursor(Buffer.from('{"createdAtIso":"not-a-date","id":"1"}', 'utf8').toString('base64url'))).toThrow(/createdAtIso/);
    expect(() => decodeCursor(Buffer.from('{"createdAtIso":"2026-01-01T00:00:00Z","id":"xx"}', 'utf8').toString('base64url'))).toThrow(/BigInt/);
  });
});

describe('buildTypeFilter', () => {
  it('types=undefined, showSystem=false → notIn SYSTEM_EVENT_TYPES', () => {
    expect(buildTypeFilter(undefined, false)).toEqual({ notIn: SYSTEM_EVENT_TYPES });
  });

  it('types=undefined, showSystem=true → undefined (нет фильтра)', () => {
    expect(buildTypeFilter(undefined, true)).toBeUndefined();
  });

  it('types=[], showSystem=false → notIn (пустой массив = нет whitelist)', () => {
    expect(buildTypeFilter([], false)).toEqual({ notIn: SYSTEM_EVENT_TYPES });
  });

  it('types=["game_end","page_view"], showSystem=false → in без page_view', () => {
    expect(buildTypeFilter(['game_end', 'page_view'], false))
      .toEqual({ in: ['game_end'] });
  });

  it('types=["game_end","page_view"], showSystem=true → in оставляет как есть', () => {
    expect(buildTypeFilter(['game_end', 'page_view'], true))
      .toEqual({ in: ['game_end', 'page_view'] });
  });

  it('types=["page_view"], showSystem=false → in=[] (никогда не вернёт строк)', () => {
    expect(buildTypeFilter(['page_view'], false)).toEqual({ in: [] });
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
