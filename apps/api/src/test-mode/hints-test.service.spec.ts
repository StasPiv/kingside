/**
 * KS-4759 / ADR-150 T1. Smoke-spec для HintsTestService.
 * Не требует реального PG/Redis — моки.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { HintsTestService } from './hints-test.service';

describe('HintsTestService (KS-4759)', () => {
  let eventsPrisma: any;
  let owner: any;
  let redis: any;
  let svc: HintsTestService;

  beforeEach(() => {
    owner = {
      actorEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      },
      actorHintState: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    eventsPrisma = { getOwner: jest.fn().mockReturnValue(owner) };
    redis = {
      del: jest.fn().mockResolvedValue(1),
      scan: jest.fn().mockResolvedValue(['0', []]),
    };
    const hints = { checkFor: jest.fn().mockResolvedValue(null) } as any;
    const config = { get: jest.fn().mockReturnValue('test-secret') } as any;
    svc = new HintsTestService(eventsPrisma, redis, hints, config);
  });

  describe('seedEvents', () => {
    it('INSERT createMany с явным createdAt + payload', async () => {
      const r = await svc.seedEvents(
        { type: 'user', id: 'u-1' },
        [
          { type: 'game_end', payload: { result: 'loss' }, created_at: '2026-06-20T10:00:00.000Z' },
          { type: 'game_end', payload: { result: 'win' }, created_at: '2026-06-21T11:00:00.000Z' },
        ],
      );
      expect(r).toEqual({ inserted: 3 });
      const args = owner.actorEvent.createMany.mock.calls[0][0];
      expect(args.data).toHaveLength(2);
      expect(args.data[0]).toMatchObject({
        actorId: 'u-1',
        actorType: 'user',
        type: 'game_end',
        payload: { result: 'loss' },
      });
      expect(args.data[0].createdAt).toEqual(new Date('2026-06-20T10:00:00.000Z'));
    });

    it('payload отсутствует → {} в БД', async () => {
      await svc.seedEvents(
        { type: 'guest', id: 'g-1' },
        [{ type: 'page_view', created_at: '2026-06-22T00:00:00.000Z' }],
      );
      const args = owner.actorEvent.createMany.mock.calls[0][0];
      expect(args.data[0].payload).toEqual({});
    });

    it('owner=null → 503', async () => {
      eventsPrisma.getOwner.mockReturnValue(null);
      await expect(
        svc.seedEvents({ type: 'user', id: 'u-1' }, [{ type: 'x', created_at: '2026-06-20T10:00:00.000Z' }]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('cleanActor', () => {
    it('DELETE actor_events + actor_hint_states + Redis keys', async () => {
      // scan возвращает 2 session-ключа
      redis.scan
        .mockResolvedValueOnce(['10', ['hints:session:u-1:2026-06-27']])
        .mockResolvedValueOnce(['0', ['hints:session:u-1:2026-06-28']]);
      redis.del.mockResolvedValue(1);

      const r = await svc.cleanActor({ type: 'user', id: 'u-1' });
      expect(r.eventsDeleted).toBe(7);
      expect(r.statesDeleted).toBe(2);
      expect(owner.actorEvent.deleteMany).toHaveBeenCalledWith({
        where: { actorId: 'u-1', actorType: 'user' },
      });
      expect(owner.actorHintState.deleteMany).toHaveBeenCalledWith({
        where: { actorId: 'u-1', actorType: 'user' },
      });
      expect(redis.del).toHaveBeenCalled();
      expect(r.redisKeysDeleted).toBeGreaterThan(0);
    });

    it('owner=null → 503', async () => {
      eventsPrisma.getOwner.mockReturnValue(null);
      await expect(svc.cleanActor({ type: 'user', id: 'u-1' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('refreshMatviews', () => {
    it('REFRESH CONCURRENTLY каждого matview, ошибка пропускается', async () => {
      owner.$executeRawUnsafe
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('matview not exists'))
        .mockResolvedValueOnce(0);
      const r = await svc.refreshMatviews();
      expect(owner.$executeRawUnsafe).toHaveBeenCalledTimes(3);
      expect(r.refreshed).toEqual([
        'events.actor_event_counts_24h',
        'events.actor_event_counts_30d',
      ]);
    });

    it('owner=null → 503', async () => {
      eventsPrisma.getOwner.mockReturnValue(null);
      await expect(svc.refreshMatviews()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  // KS-4762 / ADR-150 T4.
  describe('evaluateRuleByKey', () => {
    let hints: any;

    beforeEach(() => {
      hints = { checkFor: jest.fn() };
      owner.hint = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'h-1',
          key: 'test-rule',
          rule: { actorType: { equals: 'user' } },
        }),
      };
      owner.actorEvent = {
        ...owner.actorEvent,
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      };
      const config = { get: jest.fn().mockReturnValue('test-secret') } as any;
    svc = new HintsTestService(eventsPrisma, redis, hints, config);
    });

    it('matched=true для подходящего правила', async () => {
      const r = await svc.evaluateRuleByKey(
        { type: 'user', id: 'u-1' },
        { page: '/' },
        'test-rule',
      );
      expect(r).toEqual({ matched: true });
      expect(owner.hint.findFirst).toHaveBeenCalledWith({
        where: { key: 'test-rule', enabled: true, deletedAt: null },
      });
    });

    it('404 если правила с таким key нет', async () => {
      owner.hint.findFirst.mockResolvedValue(null);
      const { NotFoundException } = await import('@nestjs/common');
      await expect(
        svc.evaluateRuleByKey({ type: 'user', id: 'u-1' }, {}, 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner=null → 503', async () => {
      eventsPrisma.getOwner.mockReturnValue(null);
      await expect(
        svc.evaluateRuleByKey({ type: 'user', id: 'u-1' }, {}, 'x'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
