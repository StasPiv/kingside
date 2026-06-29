/**
 * KS-4799 / ADR-152 §2.1. Юнит-тесты для `MeController.listEvents`:
 *   - actor фиксируется на сервере (req.user.id, type='user');
 *   - opts.cursor парсится из base64url; невалидный → 400 BadRequest;
 *   - default'ы limit/showSystem применяются;
 *   - types/showSystem пробрасываются как есть.
 *
 * Остальные `/me/*` эндпоинты у нас уже есть с собственным spec'ом
 * (см. analytics-data.service.spec.ts) — здесь только новая логика.
 */
import { BadRequestException } from '@nestjs/common';
import { MeController } from './me.controller';
import {
  encodeCursor,
  type ListEventsOptions,
  type ListEventsResult,
} from '../events/analytics-data.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

function makeReq(userId: string): AuthenticatedRequest {
  return { user: { id: userId } } as unknown as AuthenticatedRequest;
}

function makeController(stub: {
  listEvents: jest.Mock;
}) {
  const analyticsData = {
    listEvents: stub.listEvents,
    deleteActorData: jest.fn(),
    streamExport: jest.fn(),
  } as any;
  const events = { invalidateConsentCache: jest.fn() } as any;
  const prisma = {} as any;
  const redis = {} as any;
  return new MeController(prisma, redis, analyticsData, events);
}

describe('MeController.listEvents', () => {
  it('передаёт actor с req.user.id и type="user" (фильтр зашит на сервере)', async () => {
    const listEvents = jest.fn<Promise<ListEventsResult>, [unknown, ListEventsOptions]>()
      .mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents(makeReq('u-1'), {} as never);
    expect(listEvents.mock.calls[0][0]).toEqual({ type: 'user', id: 'u-1' });
  });

  it('default limit=50, showSystem=false когда DTO пустой', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents(makeReq('u-1'), {} as never);
    expect(listEvents.mock.calls[0][1]).toMatchObject({ limit: 50, showSystem: false, cursor: undefined });
  });

  it('пробрасывает limit/types/showSystem из DTO', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    await ctrl.listEvents(makeReq('u-1'), {
      limit: 25,
      types: ['game_end', 'puzzle_solved'],
      showSystem: true,
    } as never);
    expect(listEvents.mock.calls[0][1]).toMatchObject({
      limit: 25,
      types: ['game_end', 'puzzle_solved'],
      showSystem: true,
    });
  });

  it('cursor парсится из base64url в (createdAt, id)', async () => {
    const listEvents = jest.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false, retention_days: 90 });
    const ctrl = makeController({ listEvents });
    const cursor = encodeCursor({ createdAt: new Date('2026-06-20T10:00:00Z'), id: BigInt(42) });
    await ctrl.listEvents(makeReq('u-1'), { cursor } as never);
    const opts = listEvents.mock.calls[0][1];
    expect(opts.cursor?.id).toBe(BigInt(42));
    expect(opts.cursor?.createdAt.toISOString()).toBe('2026-06-20T10:00:00.000Z');
  });

  it('невалидный cursor → 400 BadRequest, сервис не дёрнут', async () => {
    const listEvents = jest.fn();
    const ctrl = makeController({ listEvents });
    await expect(
      ctrl.listEvents(makeReq('u-1'), { cursor: '!!!not-base64!!!' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('возвращает результат сервиса как есть', async () => {
    const result = {
      items: [{ id: '1', type: 'game_end', payload: {}, created_at: '2026-06-20T10:00:00.000Z' }],
      next_cursor: 'next-tok',
      has_more: true,
      retention_days: 90,
    };
    const listEvents = jest.fn().mockResolvedValue(result);
    const ctrl = makeController({ listEvents });
    const r = await ctrl.listEvents(makeReq('u-1'), {} as never);
    expect(r).toBe(result);
  });
});
